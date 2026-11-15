/**
 * 双模式配置：**本地目录** 与 **WebDAV 云端**。
 *
 * 为什么要有这一层：插件原来只有一个 `root`（本机目录）。加了云端模式之后，
 * 配置里同时存在两组字段，而「哪一组生效」只由 `mode` 决定 —— 如果不把
 * 归一化 / 校验 / 生效值解析收在一个纯函数模块里，`index.js`、HTTP 路由、
 * 设置页三处迟早会各写一套判定，然后互相打架。
 *
 * 三条约定（改动时别破坏）：
 * 1. **互斥**：`mode=local` 时只看 `local.root`；`mode=cloud` 时只看 `cloud.*`。
 *    另一组字段原样保留但不参与任何行为，切回去时值还在。
 * 2. **兼容**：旧的顶层 `root` 仍然有效，等价于 `local.root`（`local.root` 优先）。
 *    旧的 `~/.config/agentmemory-webdav.json` 里的 `localRoot` 继续作为本地库根的
 *    兜底来源；它不再被云端模式隐式继承（云端一律以显式配置为准，避免"以为连的是 A 站"）。
 * 3. **纯函数**：这里不读 DSH 宿主、不发网络请求、不写文件；只有 `readLegacyFile()`
 *    会读一次那个历史配置文件（读不到返回 null，不抛）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_ROOT, LibraryError } from './paths.mjs'

export const MODE_LOCAL = 'local'
export const MODE_CLOUD = 'cloud'
export const MODES = [MODE_LOCAL, MODE_CLOUD]

/** 历史配置文件：cron / rclone / 旧版 skill 一直在用，保留为本地库根的兜底与"一键导入"来源。 */
export const LEGACY_CONFIG_PATH = join(homedir(), '.config', 'agentmemory-webdav.json')
/** 云端模式的默认镜像根；按 URL 哈希分子目录，多个库互不覆盖。 */
export const DEFAULT_CACHE_ROOT = join(homedir(), '.cache', 'dsh-agentmemory-library')

export const DEFAULT_CLOUD = Object.freeze({
  refreshTtlMs: 60_000,
  timeoutMs: 20_000,
  retries: 2,
  insecureTls: false,
})

/** 设置页 / 错误消息里用的字段中文名。字段路径 → 标签。 */
export const FIELD_LABELS = Object.freeze({
  mode: '存储模式',
  'local.root': '本地库根目录',
  root: '本地库根目录（兼容字段 root）',
  'cloud.url': 'WebDAV 地址',
  'cloud.username': 'WebDAV 账号',
  'cloud.password': 'WebDAV 密码',
  'cloud.cacheDir': '本地镜像目录',
  'cloud.refreshTtlMs': '镜像刷新间隔',
  'cloud.timeoutMs': '请求超时',
  'cloud.retries': '失败重试次数',
  'cloud.insecureTls': '跳过 TLS 校验',
})

/**
 * 解包 schemastery 的 volatile 字段。
 *
 * DSH 的设置页把**每个 volatile 字段**换成了 `{ get() }` 持有器（`apply(ctx, config)`
 * 收到的就是这种形态，见 dsh-settings 的 `volatileForm`）。想拿到真正的值必须
 * `.get()`；忘了解包的症状是"配置明明填了却报没填"。
 * 非 volatile（或老宿主）就是普通值，原样返回。
 */
export function unwrap(value, fallback = undefined) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const got = value.get()
      return got === undefined ? fallback : got
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

const text = (value, fallback = '') => {
  const raw = unwrap(value, fallback)
  return raw === undefined || raw === null ? fallback : String(raw)
}

const num = (value, fallback) => {
  const raw = unwrap(value, fallback)
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const bool = (value, fallback = false) => {
  const raw = unwrap(value, fallback)
  if (typeof raw === 'string') return !['', '0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
  return Boolean(raw)
}

/**
 * 把 `apply()` 收到的 config（可能是持有器形态）读成普通对象。
 * 结构 = 插件 Schema 的结构，额外保留旧字段 `root`。
 */
export function readConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  // 防御：若哪天宿主把整组 `local`/`cloud` 变成节点级持有器，先解包再取字段。
  const localRaw = unwrap(source.local, {})
  const cloudRaw = unwrap(source.cloud, {})
  const local = localRaw && typeof localRaw === 'object' ? localRaw : {}
  const cloud = cloudRaw && typeof cloudRaw === 'object' ? cloudRaw : {}
  return {
    mode: text(source.mode, MODE_LOCAL).trim() || MODE_LOCAL,
    /** 旧字段：等价 local.root，local.root 优先。 */
    legacyRoot: text(source.root, '').trim(),
    local: { root: text(local.root, '').trim() },
    cloud: {
      url: text(cloud.url, '').trim(),
      username: text(cloud.username, '').trim(),
      password: text(cloud.password, ''),
      cacheDir: text(cloud.cacheDir, '').trim(),
      refreshTtlMs: num(cloud.refreshTtlMs, DEFAULT_CLOUD.refreshTtlMs),
      timeoutMs: num(cloud.timeoutMs, DEFAULT_CLOUD.timeoutMs),
      retries: num(cloud.retries, DEFAULT_CLOUD.retries),
      insecureTls: bool(cloud.insecureTls, DEFAULT_CLOUD.insecureTls),
    },
    publish: {
      script: text(source.publishScript, '/root/.agents/skills/agentmemory-library/scripts/publish.sh'),
      timeoutMs: num(source.publishTimeoutMs, 120_000),
    },
    defaultLimit: num(source.defaultLimit, 10),
    maxReadBytes: num(source.maxReadBytes, 524_288),
    guidance: bool(source.guidance, true),
  }
}

/** 读历史 WebDAV 配置（`~/.config/agentmemory-webdav.json`）。读不到/坏了都返回 null。 */
export function readLegacyFile(file = LEGACY_CONFIG_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      path: file,
      url: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      localRoot: typeof parsed.localRoot === 'string' ? parsed.localRoot : '',
      insecureTls: parsed.insecureTls === true,
      rcloneRemote: typeof parsed.rcloneRemote === 'string' ? parsed.rcloneRemote : '',
    }
  } catch {
    return null
  }
}

const fieldError = (field, code, message) => ({
  field,
  label: FIELD_LABELS[field] ?? field,
  code,
  message,
})

const isHttpUrl = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 校验配置，只校验**当前模式**那一组字段。
 *
 * @param {object} cfg `readConfig()` 的结果
 * @param {{legacy?: object|null}} [opts] 历史配置（本地库根兜底、密码是否已有）
 * @returns {{ok:boolean, errors:Array, warnings:Array}}
 */
export function validateConfig(cfg, { legacy = null, hasStoredPassword = false } = {}) {
  const errors = []
  const warnings = []

  if (!MODES.includes(cfg.mode)) {
    errors.push(
      fieldError('mode', 'BAD_ENUM', `存储模式只能是 ${MODES.join(' / ')}，收到「${cfg.mode}」`),
    )
  }

  if (cfg.mode === MODE_CLOUD) {
    if (!cfg.cloud.url) {
      errors.push(fieldError('cloud.url', 'REQUIRED', '云端模式必须填写 WebDAV 地址'))
    } else if (!isHttpUrl(cfg.cloud.url)) {
      errors.push(
        fieldError('cloud.url', 'BAD_URL', `WebDAV 地址必须以 http:// 或 https:// 开头：${cfg.cloud.url}`),
      )
    } else {
      try {
        const parsed = new URL(cfg.cloud.url)
        if (parsed.username || parsed.password) {
          errors.push(
            fieldError(
              'cloud.url',
              'BAD_URL',
              '不要把账号密码写进 URL（https://user:pass@…）；请分别填到「账号」「密码」两项',
            ),
          )
        }
      } catch {
        /* isHttpUrl 已经挡过 */
      }
    }
    if (!cfg.cloud.username) {
      errors.push(fieldError('cloud.username', 'REQUIRED', '云端模式必须填写 WebDAV 账号'))
    }
    if (!cfg.cloud.password && !hasStoredPassword) {
      errors.push(fieldError('cloud.password', 'REQUIRED', '云端模式必须填写 WebDAV 密码（已保存过可留空）'))
    }
    if (cfg.cloud.cacheDir && !isAbsolute(cfg.cloud.cacheDir)) {
      errors.push(
        fieldError('cloud.cacheDir', 'RELATIVE_PATH', '镜像目录必须是绝对路径（例如 /root/.cache/agentmemory）'),
      )
    }
    if (!Number.isFinite(cfg.cloud.refreshTtlMs) || cfg.cloud.refreshTtlMs < 0 || cfg.cloud.refreshTtlMs > 3_600_000) {
      errors.push(fieldError('cloud.refreshTtlMs', 'BAD_NUMBER', '镜像刷新间隔需在 0–3600000 毫秒之间'))
    }
    if (!Number.isFinite(cfg.cloud.timeoutMs) || cfg.cloud.timeoutMs < 1_000 || cfg.cloud.timeoutMs > 600_000) {
      errors.push(fieldError('cloud.timeoutMs', 'BAD_NUMBER', '请求超时需在 1000–600000 毫秒之间'))
    }
    if (!Number.isFinite(cfg.cloud.retries) || cfg.cloud.retries < 0 || cfg.cloud.retries > 5) {
      errors.push(fieldError('cloud.retries', 'BAD_NUMBER', '失败重试次数需在 0–5 之间'))
    }
  } else {
    const configured = cfg.local.root || cfg.legacyRoot
    if (configured && !isAbsolute(configured)) {
      errors.push(
        fieldError(
          cfg.local.root ? 'local.root' : 'root',
          'RELATIVE_PATH',
          '本地库根目录必须是绝对路径（例如 /root/copyparty/library/Obsidian/AgentMemory）',
        ),
      )
    }
    if (!configured) {
      const fallback = legacy?.localRoot || ''
      warnings.push({
        field: 'local.root',
        code: 'LOCAL_ROOT_DEFAULTED',
        message: fallback
          ? `未填写本地库根，将沿用旧配置里的 localRoot：${fallback}`
          : '未填写本地库根，将按 AGENTMEMORY_ROOT → 默认路径解析',
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 解析**生效值**（真正拿去开后端的那份）。优先级写在这里，别处不许再写一套。
 *
 * 本地库根：`local.root` → 旧字段 `root` → `AGENTMEMORY_ROOT` →
 *          `~/.config/agentmemory-webdav.json` 的 `localRoot` → `DEFAULT_ROOT`。
 * 云端：一律用 `cloud.*`，不从历史配置继承（避免"以为连的是 A 站"）。
 */
export function resolveEffective(cfg, { env = process.env, legacy = null } = {}) {
  let root = cfg.local.root
  let rootSource = 'local.root'
  if (!root && cfg.legacyRoot) {
    root = cfg.legacyRoot
    rootSource = 'root（兼容字段）'
  }
  if (!root) {
    const fromEnv = typeof env.AGENTMEMORY_ROOT === 'string' ? env.AGENTMEMORY_ROOT.trim() : ''
    if (fromEnv) {
      root = fromEnv
      rootSource = 'AGENTMEMORY_ROOT'
    } else if (legacy?.localRoot) {
      root = legacy.localRoot
      rootSource = '~/.config/agentmemory-webdav.json:localRoot'
    } else {
      rootSource = '默认路径'
    }
  }
  root = resolve(root || DEFAULT_ROOT)

  const mirrorDir = cfg.cloud.cacheDir
    ? resolve(cfg.cloud.cacheDir)
    : join(DEFAULT_CACHE_ROOT, createHash('sha1').update(cfg.cloud.url || 'unset').digest('hex').slice(0, 12))

  return {
    mode: cfg.mode,
    local: {
      root,
      source: rootSource,
      exists: existsSync(root),
    },
    cloud: {
      url: cfg.cloud.url,
      username: cfg.cloud.username,
      password: cfg.cloud.password,
      passwordSet: Boolean(cfg.cloud.password),
      cacheDir: mirrorDir,
      cacheDirSource: cfg.cloud.cacheDir ? '配置' : '默认（按 URL 哈希）',
      host: (() => {
        try {
          return new URL(cfg.cloud.url).host
        } catch {
          return ''
        }
      })(),
      refreshTtlMs: cfg.cloud.refreshTtlMs,
      timeoutMs: cfg.cloud.timeoutMs,
      retries: cfg.cloud.retries,
      insecureTls: cfg.cloud.insecureTls,
    },
    publish: cfg.publish,
    defaultLimit: cfg.defaultLimit,
    maxReadBytes: cfg.maxReadBytes,
    guidance: cfg.guidance,
  }
}

/** 配置体检：读 → 校验 → 生效值。`ok:false` 时不抛，交给调用方决定怎么报。 */
export function inspectConfig(raw, { env = process.env, legacy = readLegacyFile(), hasStoredPassword } = {}) {
  const cfg = readConfig(raw)
  const passwordSet = Boolean(cfg.cloud.password) || Boolean(hasStoredPassword)
  const validation = validateConfig(cfg, { legacy, hasStoredPassword: passwordSet })
  return {
    cfg,
    passwordSet,
    ...validation,
    effective: validation.ok ? resolveEffective(cfg, { env, legacy }) : null,
  }
}

/** 校验失败时抛结构化错误（工具里由 toFailure 折成 ok:false）。 */
export function assertConfig(inspection) {
  if (inspection.ok) return inspection.effective
  const detail = inspection.errors.map((e) => `${e.label}：${e.message}`).join('；')
  const error = new LibraryError('CONFIG_INVALID', `配置不完整或不合法 —— ${detail}`)
  error.details = inspection.errors
  throw error
}

/** 后端缓存键：模式或任一连接参数变了就重建后端（密码只进哈希，不落日志）。 */
export function signatureOf(effective) {
  const payload = JSON.stringify({
    mode: effective.mode,
    root: effective.local.root,
    url: effective.cloud.url,
    username: effective.cloud.username,
    password: effective.cloud.password,
    cacheDir: effective.cloud.cacheDir,
    ttl: effective.cloud.refreshTtlMs,
    timeout: effective.cloud.timeoutMs,
    retries: effective.cloud.retries,
    insecureTls: effective.cloud.insecureTls,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}