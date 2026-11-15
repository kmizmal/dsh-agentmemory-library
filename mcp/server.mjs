#!/usr/bin/env node
/**
 * dsh-agentmemory-library 的 MCP 兼容层（stdio 传输，零依赖）。
 *
 * 它做的事只有一件：把本仓库 `lib/` 里现成的后端（LocalBackend / CloudBackend）
 * 暴露成 MCP 的七个工具，名字与 DSH 原生工具**完全同名**：
 *   library_search / library_list / library_read / library_write /
 *   library_replace / library_publish / library_status
 *
 * 为什么不新增依赖：DSH 只装了 @modelcontextprotocol/core 与 /client（客户端侧），
 * 没有 /server 包。MCP 的 stdio 传输本身只是「一行一个 JSON-RPC 2.0 消息」，
 * 用 readline 就够了 —— 见 docs/MCP-COMPAT.md §为什么手写传输。
 *
 * 三条硬约束（与 index.js 同源，改代码时别破坏）：
 * 1) 永不把异常抛给宿主：每个请求都包 try/catch，失败回结构化 JSON + isError:true。
 * 2) 写入只落在库根（或云端镜像）内 —— 路径校验复用 lib/paths.mjs，不自己实现。
 * 3) 配置从环境变量来（AGENTMEMORY_*），因为 MCP 客户端只会传 env/args；
 *    与插件配置同名的键优先，所以同一台机器上「插件怎么配的，MCP 就怎么用」。
 */
import { createInterface } from 'node:readline'
import { BackendPool } from '../lib/backend.mjs'
import { inspectConfig, readConfig, readLegacyFile, resolveEffective, signatureOf } from '../lib/config.mjs'
import { runPublish } from '../lib/publish.mjs'

/** 协议版本：客户端请求的版本若在支持列表里就回声，否则用最新。 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]
const SERVER_INFO = { name: 'agentmemory-library', version: '0.3.0' }

/** 从环境变量拼出与插件同形的配置对象。 */
function configFromEnv(env = process.env) {
  const pick = (key) => (env[key] ?? '').trim()
  const mode = pick('AGENTMEMORY_MODE') || 'local'
  return readConfig({
    mode,
    // 兼容字段：AGENTMEMORY_ROOT 与插件里 local.root 的关系一致（local.root 优先）
    root: pick('AGENTMEMORY_ROOT'),
    local: { root: pick('AGENTMEMORY_LOCAL_ROOT') },
    cloud: {
      url: pick('AGENTMEMORY_CLOUD_URL'),
      username: pick('AGENTMEMORY_CLOUD_USERNAME'),
      password: env.AGENTMEMORY_CLOUD_PASSWORD ?? '',
      cacheDir: pick('AGENTMEMORY_CLOUD_CACHE_DIR'),
      refreshTtlMs: Number(pick('AGENTMEMORY_CLOUD_REFRESH_TTL_MS') || 60_000),
      timeoutMs: Number(pick('AGENTMEMORY_CLOUD_TIMEOUT_MS') || 20_000),
      retries: Number(pick('AGENTMEMORY_CLOUD_RETRIES') || 2),
      insecureTls: pick('AGENTMEMORY_CLOUD_INSECURE_TLS') === '1',
    },
    publishScript: pick('AGENTMEMORY_PUBLISH_SCRIPT') || undefined,
    defaultLimit: Number(pick('AGENTMEMORY_DEFAULT_LIMIT') || 10),
    maxReadBytes: Number(pick('AGENTMEMORY_MAX_READ_BYTES') || 524_288),
  })
}

/** 当前生效配置 + 后端（配置坏了就抛 LibraryError，由调用方转成 MCP 错误结果）。 */
const pool = new BackendPool({ logger: (m) => process.stderr.write(`[agentmemory-mcp] ${m}\n`) })
let cached = { signature: '', backend: null, effective: null }

function current() {
  const raw = configFromEnv()
  const legacy = readLegacyFile()
  const inspection = inspectConfig(raw, { legacy })
  if (!inspection.ok) {
    const detail = inspection.errors.map((e) => `${e.label}：${e.message}`).join('；')
    const err = new Error(`配置不完整或不合法 —— ${detail}`)
    err.code = 'CONFIG_INVALID'
    throw err
  }
  const effective = inspection.effective ?? resolveEffective(inspection.cfg, { legacy })
  const signature = signatureOf(effective)
  if (cached.signature !== signature) {
    cached = { signature, backend: pool.get(effective, signature), effective }
  }
  cached.backend.ensureReady()
  return cached
}

/** 工具结果里统一的「我在哪」信息。 */
const where = (backend) => {
  const info = backend.describe()
  return { mode: info.mode, root: info.root, ...(info.mirror ? { mirror: info.mirror } : {}) }
}

const asText = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

function toFailure(e, fallback = 'LIBRARY_ERROR') {
  return fail(e?.code && /^[A-Z_]+$/.test(e.code) ? e.code : fallback, String(e?.message ?? e), e?.details ? { details: e.details } : {})
}

// ─── 七个工具 ────────────────────────────────────────────────────────────────
// 参数 schema 与 index.js 里的 defineTool 定义逐字对齐；description 也照抄，
// 这样同一套引导文案在 DSH 内建工具面和 MCP 面都成立。
const TOOLS = [
  {
    name: 'library_search',
    description:
      '在 AgentMemory 资料库（跨会话工作记忆归档）里做全文检索。多关键词用空格分隔，AND 关系。' +
      '任务涉及「以前做过什么」「上次怎么解决的」「这台机器上验证过什么」时先用它，别凭训练数据回答既往事实。' +
      '云端模式下检索读的是本地镜像（结果里的 stale=true 表示这次没连上服务端）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，多词用空格分隔（AND 关系）' },
        tag: { type: 'string', description: '按 frontmatter 标签过滤，例如 技术/hid' },
        titlesOnly: { type: 'boolean', description: '只查标题与 frontmatter 区（用于先定位主题）' },
        limit: { type: 'number', description: '返回条数上限（默认取插件配置）' },
      },
      required: ['query'],
    },
    async run(args) {
      const { backend, effective } = current()
      const r = await backend.search(args.query, {
        titlesOnly: Boolean(args.titlesOnly),
        tag: args.tag ?? '',
        limit: args.limit ?? effective.defaultLimit,
      })
      if (!r.total) return { ok: true, ...where(backend), ...r, hint: `库根 ${backend.describe().root}；换更短的关键词再试` }
      return { ok: true, ...where(backend), ...r }
    },
  },
  {
    name: 'library_list',
    description:
      '列 AgentMemory 资料库的目录内容（带标题/摘要/标签），或不传 dir 时按修改时间列最近改动的文件。' +
      '不知道库里有什么时候先调它，或先读 00 总览.md。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '库内相对目录，例如 主题 或 经验库；留空=按 mtime 列全库最近改动' },
        limit: { type: 'number', description: '不传 dir 时的返回条数（默认 50）' },
      },
    },
    async run(args) {
      const { backend } = current()
      const r = await backend.list(args.dir ?? '', { limit: args.limit ?? 50 })
      return {
        ok: true,
        ...where(backend),
        dir: args.dir ?? '(最近改动)',
        total: r.entries.length,
        entries: r.entries,
        ...(r.warning ? { ...(r.stale ? { stale: true } : {}), warning: r.warning } : {}),
      }
    },
  },
  {
    name: 'library_read',
    description:
      '读 AgentMemory 资料库里的一个文件，返回解析后的 frontmatter 与带行号的内容。' +
      '路径可以只写文件名片段（插件会自动匹配）；大文件请用 lines 指定区间。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径或文件名片段，例如 主题/copyparty 或 00 总览.md' },
        lines: { type: 'string', description: '行区间，形如 "40-90" 或 "120"' },
      },
      required: ['path'],
    },
    async run(args) {
      const { backend, effective } = current()
      const r = await backend.read(args.path, { lines: args.lines, maxBytes: effective.maxReadBytes })
      return { ok: true, ...where(backend), ...r }
    },
  },
  {
    name: 'library_write',
    description:
      '把文本写进 AgentMemory 资料库（只能是库根内的相对路径）。写库**不需要**先/后跑 publish：' +
      'library_search / library_list 每次都现扫，新内容立刻可搜。publish 只服务 _索引.md 与 CLI 元数据，' +
      '可传 publish:true 让这一次写顺带收尾（云端模式不跑 publish，写入直接同步到 WebDAV）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径，例如 主题/新主题.md；不接受绝对路径与 ..' },
        content: { type: 'string', description: '完整文件内容（markdown 建议带 frontmatter）' },
        mode: { type: 'string', enum: ['overwrite', 'create', 'append'], description: 'overwrite（默认）| create | append' },
        publish: { type: 'boolean', description: '写成功后顺带跑一次 library_publish（默认 false）' },
      },
      required: ['path', 'content'],
    },
    async run(args) {
      const { backend, effective } = current()
      const mode = args.mode ?? 'overwrite'
      if (!['overwrite', 'create', 'append'].includes(mode)) throw fail('BAD_MODE', `mode 只能是 overwrite / create / append，收到 ${mode}`)
      const r = await backend.write(args.path, args.content, { mode })
      const published = await maybePublish(Boolean(args.publish), backend, effective)
      return { ok: true, ...where(backend), ...r, ...(published ? { publish: published } : {}), hint: writeHint(r.changed, published, backend) }
    },
  },
  {
    name: 'library_replace',
    description:
      '在资料库里做精准文本替换：把文件里的 oldString 换成 newString，不必整份重写。' +
      '默认要求 oldString 唯一命中，命中多处会拒绝并列出命中行号 —— 这时把 oldString 扩到能唯一定位，' +
      '或显式传 all:true 全部替换。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径，例如 经验库/Linux 与 DSH 环境踩坑.md' },
        oldString: { type: 'string', description: '要被替换的原文，必须逐字符一致（含空白/缩进/全角标点）' },
        newString: { type: 'string', description: '替换成的新文本；纯删除请传空串' },
        all: { type: 'boolean', description: '允许替换全部命中（默认 false：命中不唯一就报错）' },
        count: { type: 'number', description: '要求命中的次数，不符则拒绝（可选，用于语义自检）' },
        publish: { type: 'boolean', description: '替换成功后顺带跑一次 library_publish（默认 false）' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    async run(args) {
      const { backend, effective } = current()
      const r = await backend.replace(args.path, {
        oldString: args.oldString,
        newString: args.newString,
        all: Boolean(args.all),
        count: args.count,
      })
      const published = await maybePublish(Boolean(args.publish), backend, effective)
      return { ok: true, ...where(backend), ...r, ...(published ? { publish: published } : {}), hint: writeHint(r.changed, published, backend) }
    },
  },
  {
    name: 'library_publish',
    description:
      '重建 _索引.md / _index.json、检查 copyparty 服务健康、核对每日备份时效。写库不需要它；' +
      '只有想让 Obsidian 索引页 / CLI 元数据立刻跟上时才跑。退出码 0 成功 / 1 索引失败 / 2 服务异常或备份过期。' +
      '仅本地模式可用（云端模式真源在服务端）。',
    inputSchema: {
      type: 'object',
      properties: {
        check: { type: 'boolean', description: '只体检（列最近 15 分钟改动），不重建索引' },
        noVerify: { type: 'boolean', description: '跳过服务与备份检查（copyparty 没跑时）' },
      },
    },
    async run(args) {
      const { backend, effective } = current()
      if (!backend.publishSupported) return fail('PUBLISH_CLOUD_UNSUPPORTED', backend.publishNote, { mode: 'cloud' })
      const extra = []
      if (args.check) extra.push('--check')
      if (args.noVerify) extra.push('--no-verify')
      return { ...(await runPublish(effective.publish.script, extra, { timeoutMs: effective.publish.timeoutMs })), mode: backend.mode }
    },
  },
  {
    name: 'library_status',
    description:
      '看资料库当前走哪条后端（local / cloud）、库根或镜像目录在哪、云端连接与最近一次同步的状态。' +
      '排查「为什么读不到/写不进去」时先调它；probe=true 会真的去连一次 WebDAV。',
    inputSchema: {
      type: 'object',
      properties: { probe: { type: 'boolean', description: '云端模式下真的发一次 PROPFIND 探活' } },
    },
    async run(args) {
      const { backend } = current()
      return { ok: true, ...(await backend.status({ probe: Boolean(args.probe) })) }
    },
  },
]

async function maybePublish(flag, backend, effective) {
  if (!flag) return undefined
  if (!backend.publishSupported) return fail('PUBLISH_CLOUD_UNSUPPORTED', backend.publishNote, { mode: backend.mode })
  try {
    return await runPublish(effective.publish.script, [], { timeoutMs: effective.publish.timeoutMs })
  } catch (e) {
    return { ok: false, ...toFailure(e, 'PUBLISH_FAILED') }
  }
}

const writeHint = (changed, published, backend) => {
  const tail = published ? (published.ok ? '；publish 已跑完' : `；publish 失败（${published.code ?? published.exitCode ?? '未知'}）`) : ''
  if (!changed) return `内容与磁盘一致，未改动文件${tail}`
  return published ? `已落盘${tail}` : '已落盘；检索不读索引，新内容立即可搜'
}

// ─── JSON-RPC 分发 ───────────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg
  // 通知类消息（没有 id）不回包，只处理副作用
  if (id === undefined) {
    if (method === 'notifications/initialized') process.stderr.write('[agentmemory-mcp] client initialized\n')
    return null
  }
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'AgentMemory 资料库读写。先用 library_status 确认后端与库根，再 library_search / library_list 定位，' +
            'library_read 读、library_write / library_replace 写。写库不必 publish（检索每次现扫）。',
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } }
      try {
        const value = await tool.run(params.arguments ?? {})
        // 工具级失败（ok:false）也走正常结果，只标 isError —— 模型能看到 code 与原因
        const isError = value?.ok === false
        return { jsonrpc: '2.0', id, result: { content: asText(value), isError, ...(isError ? {} : { structuredContent: value }) } }
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: asText(toFailure(e)), isError: true } }
      }
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

const send = (obj) => {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  } catch {
    /* stdout 已关闭，退出即可 */
  }
}

// stdio 是「一行一条消息」：readline 负责切帧，自己维护串行队列保证写回顺序
let queue = Promise.resolve()
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const text = line.trim()
  if (!text) return
  queue = queue.then(async () => {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    try {
      const reply = await handle(msg)
      if (reply) send(reply)
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } })
    }
  })
})

process.stderr.write(`[agentmemory-mcp] ready (protocol ${LATEST_PROTOCOL}, 7 tools)\n`)