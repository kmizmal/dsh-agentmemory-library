/**
 * dsh-agentmemory-library —— 把本机 AgentMemory 资料库的读写注册成原生 DSH 工具。
 *
 * 双模式（0.3.0 起）：
 * - `mode=local`：读写都在本机目录（旧行为，配置项 `root` 继续有效）。
 * - `mode=cloud`：真源在 WebDAV，读写走云端；检索/列表/读取走本地镜像缓存。
 *   切换只改 `mode`，下一次工具调用就换后端，不用重启。
 *
 * 三条硬约束（都是 0.2.1-rc.5 上的实测结论，不是推测）：
 * 1) 必须**全局**注册。模型工具列表用 `scope: agent`（Agent 对象，不是 scope key）
 *    组装，agent 作用域注册永远到不了模型。要按会话裁剪只能用 ctx.tools.guard()
 *    或 per-session prompt section —— 本插件不改别人的可见性，故不做裁剪；
 *    群聊 preset 的剔除由 tool-filter.mjs 自己在 restrict 面做。
 * 2) apply() 里绝不 throw。抛出去会被 loader 报 "did not activate"，桌面端升级成
 *    拒绝启动 + profile 恢复流程。工具注册失败只 logger.error，其余工具照常上。
 * 3) 写入只落在库根（或云端镜像）内，且不经 ctx.fs —— 那条路会带会话的文件沙箱策略，
 *    资料库在 /root/copyparty 下，沙箱里的会话根本写不进去。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_ROOT, LibraryError } from './lib/paths.mjs'
import { runPublish } from './lib/publish.mjs'
import {
  MODE_CLOUD,
  MODE_LOCAL,
  defaultPublishScript,
  inspectConfig,
  readConfig,
  readLegacyFile,
  resolveEffective,
  signatureOf,
} from './lib/config.mjs'
import { BackendPool } from './lib/backend.mjs'
import { createApiHandler } from './lib/api.mjs'

export const name = 'dsh-agentmemory-library'

/** 只需要 tools；webServer / settings 用 ctx.inject / ctx.get 按需取，不阻塞激活。 */
export const inject = ['tools']

/** loader 条目 id，也是设置表单的命名空间（`ctx.settings.describe()` 里的 ns）。 */
export const SETTINGS_NS = 'agentmemory-library'

/**
 * 配置 Schema。
 *
 * 🔴 每个可编辑字段都必须 `.volatile()`：DSH 的设置页只投影 volatile 字段
 *    （`volatileForm()`），漏标 = 设置页上整块消失。volatile 的代价是 `apply()`
 *    收到的 config 里这些字段变成 `{ get() }` 持有器 —— 读的时候必须 `unwrap()`。
 *
 * 两组字段互斥：`mode=local` 只看 `local.*`，`mode=cloud` 只看 `cloud.*`；
 * 另一组原样保存在配置里，切回去还在。
 */
export const Config = z.object({
  mode: z
    .union([z.const(MODE_LOCAL), z.const(MODE_CLOUD)])
    .default(MODE_LOCAL)
    .volatile()
    .description('存储模式：local=本机目录；cloud=WebDAV 云端（检索走本地镜像缓存）'),

  root: z
    .string()
    .default('')
    .volatile()
    .description('【兼容字段，等价 local.root】本地模式库根；新配置请用 local.root'),

  local: z.object({
    root: z
      .string()
      .default('')
      .volatile()
      .description(
        '本地模式：库根目录（绝对路径）。留空 = AGENTMEMORY_ROOT → ~/.config/agentmemory-webdav.json 的 localRoot → 默认路径',
      ),
  }),

  cloud: z.object({
    url: z
      .string()
      .default('')
      .volatile()
      .description('云端模式：WebDAV 根地址（指到库目录，建议以 / 结尾），必填'),
    username: z.string().default('').volatile().description('云端模式：WebDAV 账号，必填'),
    password: z
      .string()
      .role('secret')
      .default('')
      .volatile()
      .description('云端模式：WebDAV 密码/应用密码，必填；只写不回显，已保存时留空表示不修改'),
    cacheDir: z
      .string()
      .default('')
      .volatile()
      .description('云端模式：本地镜像目录（绝对路径）。留空 = ~/.cache/dsh-agentmemory-library/<URL 哈希>'),
    refreshTtlMs: z
      .natural()
      .min(0)
      .max(3_600_000)
      .default(60_000)
      .volatile()
      .description('云端模式：镜像刷新间隔（毫秒）。0 = 每次工具调用都向服务端对账'),
    timeoutMs: z
      .natural()
      .min(1_000)
      .max(600_000)
      .default(20_000)
      .volatile()
      .description('云端模式：单次 WebDAV 请求超时（毫秒）'),
    retries: z.natural().min(0).max(5).default(2).volatile().description('云端模式：网络类失败重试次数'),
    insecureTls: z.boolean().default(false).volatile().description('云端模式：跳过 TLS 证书校验（自签名/内网服务器才开）'),
  }),

  /** 收尾脚本（与 cron 共用同一份，不重写）。云端模式下不跑（见 library_publish 的说明）。 */
  publishScript: z
    .string()
    .default(defaultPublishScript())
    .volatile()
    .description('publish 脚本路径（仅本地模式）'),
  /** 单次检索/列表默认返回条数。 */
  defaultLimit: z.natural().min(1).max(50).default(10).volatile().description('检索/列表默认返回条数'),
  /** 不带 lines 时允许整篇读回的字节上限。 */
  maxReadBytes: z.natural().min(4096).default(524_288).volatile().description('整篇读回的字节上限'),
  /** publish 的超时（毫秒）。 */
  publishTimeoutMs: z.natural().min(1_000).default(120_000).volatile().description('publish 超时（毫秒）'),
  /** 是否注入一条 system prompt 说明（关掉后工具仍在，只是模型看不到引导）。 */
  guidance: z.boolean().default(true).volatile().description('是否向模型注入用法说明段'),
})

const PROMPT_SECTION_ORDER = 3300
const PROMPT_SECTION_NAME = 'agentmemory-library'

/** 统一的失败形状：不抛给宿主，模型能看到 code 与一句人话。 */
const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

function toFailure(e, fallbackCode = 'LIBRARY_ERROR') {
  if (e instanceof LibraryError) return failure(e.code, e.message, e.details ? { details: e.details } : {})
  return failure(fallbackCode, String(e?.message ?? e))
}

/** 作者态参数简写（defineTool 会编译成 JSON Schema）。 */
const str = (description, required = true) => ({
  type: 'string',
  description,
  ...(required ? { required: true } : {}),
})
const num = (description, required = false) => ({
  type: 'number',
  description,
  ...(required ? { required: true } : {}),
})
const bool = (description) => ({ type: 'boolean', description })

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const jsonText = (value) => JSON.stringify(value, null, 2)

/** 深合并两份配置：`over` 里显式给出的字段覆盖 `under`。用于「宿主设置行 > apply 快照」。 */
function mergeConfig(under = {}, over = {}) {
  const mergeGroup = (a, b) => {
    if (!b || typeof b !== 'object') return a
    const out = { ...a }
    for (const [key, value] of Object.entries(b)) {
      if (value === undefined) continue
      out[key] = key === 'cloud' || key === 'local' ? { ...(a?.[key] ?? {}), ...value } : value
    }
    return out
  }
  return mergeGroup(under, over)
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('agentmemory-library')
  const snapshot = config && typeof config === 'object' ? config : {}
  const pool = new BackendPool({ logger: (msg) => logger?.warn?.(msg) })

  /**
   * 读当前配置。
   *
   * 两个来源都要看：
   * - `snapshot`：apply 收到的 fiber config（volatile 字段是**活持有器**，设置页一改就变）；
   * - `ctx.settings.describe()` 的 `value`：某些宿主形态下 snapshot 是挂载时快照，
   *   设置页写入不会回灌（bili 插件踩过这个坑）⇒ 再用 describe 这份盖一层。
   * describe() 会扫全部条目，2 秒缓存挡住工具连击。
   */
  let rowCache = { at: 0, value: null }
  const settingsRow = (fresh = false) => {
    const now = Date.now()
    if (!fresh && now - rowCache.at < 2_000) return rowCache.value
    let value = null
    try {
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
      const rows = settings?.describe?.() ?? []
      const hit = rows.find((row) => row?.ns === SETTINGS_NS)
      value = hit?.value ?? null
    } catch (error) {
      logger?.warn?.(`读设置表单失败（继续用 snapshot）：${error?.message ?? error}`)
    }
    rowCache = { at: now, value }
    return value
  }

  /**
   * 供 HTTP / 设置页复用的"当前配置体检"。
   * `fresh` 跳过 2 秒缓存（设置页刚保存完要立刻看到新值）。
   */
  const currentInspection = ({ fresh = false } = {}) => {
    const row = settingsRow(fresh)
    const merged = row ? mergeConfig(snapshot, row) : snapshot
    return inspectConfig(merged, { legacy: readLegacyFile() })
  }

  /** 配置变了就换后端；后端自己负责"根不存在/连不上"的可读报错。 */
  const currentBackend = () => {
    const inspection = currentInspection()
    if (!inspection.ok) {
      const detail = inspection.errors.map((e) => `${e.label}：${e.message}`).join('；')
      const error = new LibraryError('CONFIG_INVALID', `配置不完整或不合法 —— ${detail}`)
      error.details = inspection.errors
      throw error
    }
    const effective = inspection.effective ?? resolveEffective(inspection.cfg, { legacy: readLegacyFile() })
    const backend = pool.get(effective, signatureOf(effective))
    backend.ensureReady()
    return { effective, backend, inspection }
  }

  const register = (toolName, definition) => {
    try {
      ctx.effect(
        () => ctx.tools.register(defineTool({ name: toolName, ...definition })),
        `agentmemory-library:${toolName}`,
      )
      return true
    } catch (e) {
      logger?.error?.(`register ${toolName} failed: ${e?.message ?? e}`)
      return false
    }
  }

  /** 工具结果里统一的"我在哪条路径上"信息。 */
  const where = (backend) => {
    const info = backend.describe()
    return { mode: info.mode, root: info.root, ...(info.mirror ? { mirror: info.mirror } : {}) }
  }

  // ── library_search ────────────────────────────────────────────────────────
  register('library_search', {
    description:
      '在 AgentMemory 资料库（跨会话工作记忆归档）里做全文检索。多关键词用空格分隔，AND 关系。' +
      '任务涉及「以前做过什么」「上次怎么解决的」「这台机器上验证过什么」时先用它，别凭训练数据回答既往事实。' +
      '云端模式下检索读的是本地镜像（结果里的 stale=true 表示这次没连上服务端）。',
    parameters: {
      query: str('关键词，多词用空格分隔（AND 关系）'),
      tag: str('按 frontmatter 标签过滤，例如 技术/hid', false),
      titlesOnly: bool('只查标题与 frontmatter 区（用于先定位主题）'),
      limit: num('返回条数上限（默认取插件配置）'),
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const { backend, inspection } = currentBackend()
        const limit = args.limit ?? inspection.cfg.defaultLimit
        const r = await backend.search(args.query, {
          titlesOnly: Boolean(args.titlesOnly),
          tag: args.tag ?? '',
          limit,
        })
        if (!r.total) {
          return jsonText({ ok: true, ...where(backend), ...r, hint: `库根 ${backend.describe().root}；换更短的关键词再试` })
        }
        return jsonText({ ok: true, ...where(backend), ...r })
      } catch (e) {
        return jsonText(toFailure(e, 'SEARCH_FAILED'))
      }
    },
  })

  // ── library_list ──────────────────────────────────────────────────────────
  register('library_list', {
    description:
      '列 AgentMemory 资料库的目录内容（带标题/摘要/标签），或不传 dir 时按修改时间列最近改动的文件。' +
      '不知道库里有什么时候先调它，或先读 00 总览.md。',
    parameters: {
      dir: str('库内相对目录，例如 主题 或 经验库；留空=按 mtime 列全库最近改动', false),
      limit: num('不传 dir 时的返回条数（默认 50）'),
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const { backend } = currentBackend()
        const r = await backend.list(args.dir ?? '', { limit: args.limit ?? 50 })
        return jsonText({
          ok: true,
          ...where(backend),
          dir: args.dir ?? '(最近改动)',
          total: r.entries.length,
          entries: r.entries,
          ...(r.warning ? { ...(r.stale ? { stale: true } : {}), warning: r.warning } : {}),
        })
      } catch (e) {
        return jsonText(toFailure(e, 'LIST_FAILED'))
      }
    },
  })

  // ── library_read ──────────────────────────────────────────────────────────
  register('library_read', {
    description:
      '读 AgentMemory 资料库里的一个文件，返回解析后的 frontmatter 与带行号的内容。' +
      '路径可以只写文件名片段（插件会自动匹配）；大文件请用 lines 指定区间。',
    parameters: {
      path: str('库内相对路径或文件名片段，例如 主题/copyparty 或 00 总览.md'),
      lines: str('行区间，形如 "40-90" 或 "120"', false),
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const { backend, inspection } = currentBackend()
        const r = await backend.read(args.path, { lines: args.lines, maxBytes: inspection.cfg.maxReadBytes })
        return jsonText({ ok: true, ...where(backend), ...r })
      } catch (e) {
        return jsonText(toFailure(e, 'READ_FAILED'))
      }
    },
  })

  /**
   * 可选收尾：`publish:true` 时顺手跑一次 publish.sh。
   *
   * 为什么放成可选而不是默认：publish 有进程内互斥（并发会抛 PUBLISH_IN_PROGRESS）、
   * 退出码混着「服务健康 / 备份时效」，默认合并会让「备份已 40h」把**已经落盘**的写
   * 报成失败，模型于是重试再写一遍。写库成败只该由写库本身决定。
   * 失败也不抛：折叠进 publish 字段，`ok` 仍是写库的结果。
   */
  async function maybePublish(flag, backend, inspection) {
    if (!flag) return undefined
    if (!backend.publishSupported) {
      return failure('PUBLISH_CLOUD_UNSUPPORTED', backend.publishNote, { mode: backend.mode })
    }
    try {
      return await runPublish(inspection.cfg.publish.script, [], { timeoutMs: inspection.cfg.publish.timeoutMs })
    } catch (e) {
      return { ok: false, ...toFailure(e, 'PUBLISH_FAILED') }
    }
  }

  /** 写库之后的提示。检索面不读索引，所以「不 publish 就搜不到」是错的。 */
  const writeHint = (changed, published, backend) => {
    const cloudTail = backend.mode === 'cloud' ? '；已写入 WebDAV（本地镜像同步更新）' : ''
    const tail = published
      ? published.ok
        ? '；publish 已跑完（索引、服务、备份都过）'
        : `；publish 失败（${published.code ?? published.exitCode ?? '未知原因'}），内容检索/远端同步不受影响，` +
          (backend.publishSupported ? '稍后可单独调 library_publish 重试' : '云端模式请在库主机上跑本地 publish')
      : ''
    if (!changed) return `内容与磁盘一致，未改动文件${tail}`
    if (published) return `已落盘${cloudTail}${tail}。检索本来就不读索引，新内容立刻可搜`
    return (
      `已落盘${cloudTail}；检索不读索引，新内容立即可搜。要让 _索引.md（Obsidian 索引页）与 ` +
      'CLI --index/--list 的元数据跟上，再调 library_publish —— 或下次写库时传 publish:true'
    )
  }

  // ── library_write ─────────────────────────────────────────────────────────
  register('library_write', {
    description:
      '把文本写进 AgentMemory 资料库（只能是库根内的相对路径）。写库**不需要**先/后跑 publish：' +
      'library_search / library_list 每次都现扫，新内容立刻可搜。publish 只服务 _索引.md 与 CLI 元数据，' +
      '可传 publish:true 让这一次写顺带收尾（云端模式不跑 publish，写入直接同步到 WebDAV）。',
    parameters: {
      path: str('库内相对路径，例如 主题/新主题.md；不接受绝对路径与 ..'),
      content: str('完整文件内容（markdown 建议带 frontmatter）'),
      mode: str('overwrite（默认，整份替换）| create（不存在才写）| append（追加）', false),
      publish: bool('写成功后顺带跑一次 library_publish 重建索引（默认 false：检索不需要它）'),
    },
    output: textOutput,
    async execute(args) {
      try {
        const { backend, inspection } = currentBackend()
        const mode = args.mode ?? 'overwrite'
        if (!['overwrite', 'create', 'append'].includes(mode)) {
          throw new LibraryError('BAD_MODE', `mode 只能是 overwrite / create / append，收到 ${mode}`)
        }
        const r = await backend.write(args.path, args.content, { mode })
        const published = await maybePublish(Boolean(args.publish), backend, inspection)
        return jsonText({
          ok: true,
          ...where(backend),
          ...r,
          ...(published ? { publish: published } : {}),
          hint: writeHint(r.changed, published, backend),
        })
      } catch (e) {
        return jsonText(toFailure(e, 'WRITE_FAILED'))
      }
    },
  })

  // ── library_replace ───────────────────────────────────────────────────────
  register('library_replace', {
    description:
      '在资料库里做**精准文本替换**：把文件里的 oldString 换成 newString，不必整份重写。' +
      '专为改大文件而设（几十万字节的经验库/总览也能只改一处，省 token 又不会抄漏整篇）。' +
      '默认要求 oldString 在文件里**唯一命中**，命中多处会拒绝并列出命中行号 —— 这时把 oldString ' +
      '扩到能唯一定位，或显式传 all:true 全部替换。替换后检索立刻看到新内容（检索不读索引）；' +
      '要更新 _索引.md 就传 publish:true 或之后单独调 library_publish。',
    parameters: {
      path: str('库内相对路径，例如 经验库/Linux 与 DSH 环境踩坑.md；不接受绝对路径与 ..'),
      oldString: str('要被替换的原文，必须与磁盘内容逐字符一致（含空白/缩进/全角标点）'),
      newString: str('替换成的新文本；纯删除请传空串'),
      all: bool('允许替换全部命中（默认 false：命中不唯一就报错，避免改错地方）'),
      count: num('要求命中的次数，不符则拒绝（可选，用于语义自检）'),
      publish: bool('替换成功后顺带跑一次 library_publish 重建索引（默认 false：检索不需要它）'),
    },
    output: textOutput,
    async execute(args) {
      try {
        const { backend, inspection } = currentBackend()
        const r = await backend.replace(args.path, {
          oldString: args.oldString,
          newString: args.newString,
          all: Boolean(args.all),
          count: args.count,
        })
        const published = await maybePublish(Boolean(args.publish), backend, inspection)
        return jsonText({
          ok: true,
          ...where(backend),
          ...r,
          ...(published ? { publish: published } : {}),
          hint: writeHint(r.changed, published, backend),
        })
      } catch (e) {
        return jsonText(toFailure(e, 'REPLACE_FAILED'))
      }
    },
  })

  // ── library_publish ───────────────────────────────────────────────────────
  register('library_publish', {
    description:
      '可选收尾：重建 _索引.md / _index.json、检查 copyparty 服务健康、核对每日备份时效。' +
      '写库**不需要**它（检索面每次现扫）；只有想让 Obsidian 索引页 / CLI --index、--list 的元数据' +
      '立刻跟上时才跑，攒几处改动后一次即可。等价于手工跑 scripts/publish.sh。' +
      '退出码 0 成功 / 1 索引失败 / 2 服务异常或备份过期。仅本地模式可用（云端模式真源在服务端）。',
    parameters: {
      check: bool('只体检（列最近 15 分钟改动），不重建索引'),
      noVerify: bool('跳过服务与备份检查（copyparty 没跑时）'),
    },
    output: textOutput,
    async execute(args) {
      try {
        const { backend, inspection } = currentBackend()
        if (!backend.publishSupported) {
          return jsonText({ ...failure('PUBLISH_CLOUD_UNSUPPORTED', backend.publishNote), mode: 'cloud' })
        }
        const extra = []
        if (args.check) extra.push('--check')
        if (args.noVerify) extra.push('--no-verify')
        const r = await runPublish(inspection.cfg.publish.script, extra, {
          timeoutMs: inspection.cfg.publish.timeoutMs,
        })
        return jsonText({ ...r, mode: backend.mode })
      } catch (e) {
        return jsonText(toFailure(e, 'PUBLISH_FAILED'))
      }
    },
  })

  // ── library_status ────────────────────────────────────────────────────────
  register('library_status', {
    description:
      '看资料库当前走哪条后端（local / cloud）、库根或镜像目录在哪、云端连接与最近一次同步的状态。' +
      '排查「为什么读不到/写不进去」「设置改了有没有生效」时先调它；probe=true 会真的去连一次 WebDAV。',
    parameters: {
      probe: bool('云端模式下真的发一次 PROPFIND 探活（默认 false，只看本地状态）'),
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const inspection = currentInspection()
        const configView = {
          mode: inspection.cfg.mode,
          local: {
            configured: inspection.cfg.local.root || inspection.cfg.legacyRoot || '',
            effective: inspection.effective?.local.root ?? null,
            source: inspection.effective?.local.source ?? null,
          },
          cloud: {
            url: inspection.cfg.cloud.url,
            username: inspection.cfg.cloud.username,
            passwordSet: inspection.passwordSet,
            cacheDir: inspection.effective?.cloud.cacheDir ?? null,
            cacheDirSource: inspection.effective?.cloud.cacheDirSource ?? null,
            refreshTtlMs: inspection.cfg.cloud.refreshTtlMs,
            timeoutMs: inspection.cfg.cloud.timeoutMs,
            retries: inspection.cfg.cloud.retries,
            insecureTls: inspection.cfg.cloud.insecureTls,
          },
          errors: inspection.errors,
          warnings: inspection.warnings,
        }
        if (!inspection.ok) {
          return jsonText({ ok: false, code: 'CONFIG_INVALID', config: configView })
        }
        const { backend } = currentBackend()
        const status = await backend.status({ probe: Boolean(args.probe) })
        return jsonText({ ok: true, ...status, config: configView })
      } catch (e) {
        return jsonText(toFailure(e, 'STATUS_FAILED'))
      }
    },
  })

  // ── HTTP：设置页的探活 / 刷新 / 旧配置导入 ────────────────────────────────
  try {
    const api = createApiHandler({
      ctx,
      currentInspection,
      pool,
      logger,
    })
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          webCtx.effect(
            () =>
              webCtx.webServer.register({
                kind: 'prefix',
                path: '/api/agentmemory-library',
                handler: (req, res) => api.handle(req, res),
              }),
            'agentmemory-library: /api/agentmemory-library 路由',
          )
        } catch (error) {
          logger?.error?.(`注册 /api/agentmemory-library 失败：${error?.message ?? error}`)
        }
      })
    } else {
      logger?.warn?.('没有 ctx.inject，设置页的探活接口未挂载')
    }
  } catch (e) {
    logger?.error?.(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  // ── prompt section ────────────────────────────────────────────────────────
  try {
    if (readConfig(snapshot).guidance) {
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
        const inspection = currentInspection()
        const mode = inspection.cfg.mode
        const text = [
          '# AgentMemory 资料库（跨会话记忆）',
          '',
          // ⚠️ 这段文本只在 apply() 时算一次，模式/库根在设置里改了不会自动重算。
          //    所以这里**不写**具体后端（写死了会误导模型），让它去问 library_status。
          '当前走本地目录还是 WebDAV、库根/镜像在哪：调 `library_status`（模式可在设置里切换，这段说明是静态的）。',
          '',
          '这台机器上真实发生过的事记在这里：某块硬盘为什么掉盘、某个私有协议字节是什么、',
          '某个改动"改了没生效"的真正原因、用户的协作偏好。训练数据里没有这些 ——',
          '**凡是要回答本机既往事实（"上次""以前""之前怎么配的"），先 `library_search`，再开口**。',
          '',
          '| 工具 | 用途 |',
          '| --- | --- |',
          '| `library_search` | 全文检索，多词 AND，可带 tag / titlesOnly |',
          '| `library_list` | 列目录（带摘要）或不传 dir 看最近改动 |',
          '| `library_read` | 读一篇（返回 frontmatter + 带行号正文），可用 lines 取区间 |',
          '| `library_write` | 写库/写云端（只能落在库根内）；**写完不必** publish，检索立刻能搜到 |',
          '| `library_replace` | 精准替换一处文本（改大文件用这个，别整份重写） |',
          '| `library_publish` | 重建索引 + 服务健康 + 备份时效（仅本地模式） |',
          '| `library_status` | 当前走哪条后端、云端连不连得上、镜像同步时间 |',
          '',
          '读的顺序：`00 总览.md` → `经验库/` → 具体主题。总览里的「一句话结论」经常直接就是答案。',
          '产出能复用的实证结论时写进库 —— 检索不读索引，不 publish 也查得到；',
          '`library_publish` 只服务 `_索引.md`（Obsidian 索引页）与 CLI 元数据，攒几处改动后跑一次即可。',
          '云端模式的写入会先 PUT 到 WebDAV、回读校验后再更新本地镜像；结果里 `stale:true` 表示这次没连上服务端、读的是上次同步的副本。',
        ]
          .filter(Boolean)
          .join('\n')
        ctx.effect(
          () => systemPrompt.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text }),
          'agentmemory-library: prompt section',
        )
      }
    }
  } catch (e) {
    logger?.error?.(`prompt section failed: ${e?.message ?? e}`)
  }

  try {
    const inspection = currentInspection()
    const effective = inspection.effective
    const whereText =
      inspection.cfg.mode === MODE_CLOUD
        ? `cloud ${effective?.cloud.host || '(未配置)'} → 镜像 ${effective?.cloud.cacheDir || '(未配置)'}`
        : `local ${effective?.local.root || '(未配置)'}`
    logger?.info?.(`ready; mode=${inspection.cfg.mode} ${whereText}`)
  } catch (e) {
    logger?.warn?.(`状态检查失败（不影响工具注册）：${e?.message ?? e}`)
  }
}

export { DEFAULT_ROOT }