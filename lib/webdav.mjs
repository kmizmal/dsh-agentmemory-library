/**
 * 零依赖 WebDAV 客户端（只用 node:http / node:https）。
 *
 * 为什么不用 npm 包：这个插件是 `link:` 进 profile 的，装依赖会让「换台机器」
 * 多一步 `pnpm install`；而 WebDAV 需要的动词就五个（PROPFIND / GET / PUT /
 * MKCOL / DELETE），自己写反而能把**错误分类**做成契约的一部分 —— 设置页要
 * 分得清「认证失败」「连不上」「证书不对」，通用库只会丢一个 `HTTP 401`。
 *
 * 不支持的能力（有意）：LOCK/UNLOCK、分块上传、`Depth: infinity`（不少服务端
 * 直接 403）。目录一律 `Depth: 1` 递归走，慢一点但兼容性最好。
 */
import http from 'node:http'
import https from 'node:https'
import { LibraryError } from './paths.mjs'

const USER_AGENT = 'dsh-agentmemory-library/0.3 webdav'
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024

const PROPFIND_BODY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<d:propfind xmlns:d="DAV:">',
  '  <d:prop>',
  '    <d:resourcetype/>',
  '    <d:getcontentlength/>',
  '    <d:getlastmodified/>',
  '    <d:getetag/>',
  '  </d:prop>',
  '</d:propfind>',
].join('')

const decodeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      // 越界码点会让 String.fromCodePoint 抛 RangeError，整个 PROPFIND 变网络错误
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&#${n};`
    })
    .replace(/&amp;/g, '&')

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const tagText = (block, name) => {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i')
  const hit = block.match(re)
  return hit ? decodeXml(hit[1]).trim() : ''
}

/** 把 PROPFIND 的 multistatus 拆成条目（命名空间无关，`D:`/`d:`/无前缀都认）。 */
export function parseMultistatus(xml, baseUrl) {
  const base = new URL(baseUrl)
  const basePath = safeDecode(base.pathname)
  const baseNoSlash = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const blocks = String(xml).match(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) ?? []
  const entries = []
  for (const block of blocks) {
    const href = tagText(block, 'href')
    if (!href) continue
    let pathname
    try {
      pathname = new URL(href, base).pathname
    } catch {
      continue
    }
    const decoded = safeDecode(pathname)
    if (decoded !== baseNoSlash && decoded !== basePath && !decoded.startsWith(basePath)) continue
    const rel = decoded === basePath || decoded === baseNoSlash ? '' : decoded.slice(basePath.length).replace(/\/+$/, '')
    if (!rel) continue
    const isDir = /<(?:[\w.-]+:)?collection\b[^>]*\/?>/i.test(block)
    const size = Number(tagText(block, 'getcontentlength')) || 0
    const mtime = Date.parse(tagText(block, 'getlastmodified')) || 0
    const etag = tagText(block, 'getetag')
    entries.push({ rel, isDir, size, mtime, etag })
  }
  return entries
}

const retriable = (error) =>
  error instanceof LibraryError
    ? ['CLOUD_TIMEOUT', 'CLOUD_UNREACHABLE', 'CLOUD_DNS_FAILED', 'CLOUD_SERVER_ERROR', 'CLOUD_CONNECTION_RESET'].includes(
        error.code,
      )
    : false

/** 网络层异常 → 可读的契约错误。设置页直接拿 code 分支，不解析字符串。 */
export function normalizeNetworkError(error, ctx = {}) {
  if (error instanceof LibraryError) return error
  const code = String(error?.code ?? '')
  const where = `${ctx.method ?? 'REQUEST'} ${ctx.path ?? '/'}`
  const base = { status: ctx.status, method: ctx.method, path: ctx.path, cause: error }
  const make = (codeName, message) => Object.assign(new LibraryError(codeName, message), base)

  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || /timeout/i.test(String(error?.message ?? ''))) {
    return make(
      'CLOUD_TIMEOUT',
      `WebDAV 请求超时（${ctx.timeoutMs ?? '?'}ms）：${where}；检查网络/服务端负载，或在设置里调大超时`,
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return make('CLOUD_DNS_FAILED', `WebDAV 域名解析失败（${code}）：${ctx.host ?? where}；检查地址拼写与 DNS`)
  }
  if (code === 'ECONNREFUSED') {
    return make('CLOUD_UNREACHABLE', `WebDAV 拒绝连接（ECONNREFUSED）：${ctx.host ?? where}；检查端口与服务是否在跑`)
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return make('CLOUD_CONNECTION_RESET', `WebDAV 连接被重置（${code}）：${ctx.host ?? where}；网关/反代可能是原因`)
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return make('CLOUD_UNREACHABLE', `WebDAV 网络不可达（${code}）：${ctx.host ?? where}`)
  }
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    /certificate|tls|ssl/i.test(String(error?.message ?? ''))
  ) {
    return make(
      'CLOUD_TLS_ERROR',
      `WebDAV TLS/证书校验失败（${code || 'TLS'}）：${ctx.host ?? where}；自签名证书可在设置里打开「跳过 TLS 校验」`,
    )
  }
  return make('CLOUD_NETWORK_ERROR', `WebDAV 请求失败：${where} — ${String(error?.message ?? error)}`)
}

/** 5xx/429 等状态码 → 契约错误（4xx 由调用方按语义细分）。 */
function statusError(status, ctx = {}) {
  const where = `${ctx.method ?? 'REQUEST'} ${ctx.path ?? '/'}`
  const base = { status, method: ctx.method, path: ctx.path }
  const make = (code, message) => Object.assign(new LibraryError(code, message), base)
  if (status === 401) return make('CLOUD_AUTH_FAILED', `WebDAV 认证失败（401）：${where}；检查账号/密码，或应用专用密码`)
  if (status === 403) return make('CLOUD_FORBIDDEN', `WebDAV 拒绝访问（403）：${where}；账号可能没有该目录权限`)
  if (status === 404) return make('CLOUD_NOT_FOUND', `WebDAV 路径不存在（404）：${where}；URL 需要指到库目录`)
  if (status === 405) return make('CLOUD_UNSUPPORTED', `服务端不支持该 WebDAV 方法（405）：${where}`)
  if (status === 409) return make('CLOUD_CONFLICT', `WebDAV 目录冲突（409）：${where}；父目录可能不存在`)
  if (status === 423) return make('CLOUD_LOCKED', `WebDAV 资源被锁定（423）：${where}；有客户端占着它`)
  if (status === 429) return make('CLOUD_RATE_LIMITED', `WebDAV 限流（429）：${where}；降低刷新频率再试`)
  if (status === 507) return make('CLOUD_NO_SPACE', `WebDAV 空间不足（507）：${where}`)
  if (status >= 500) return make('CLOUD_SERVER_ERROR', `WebDAV 服务端错误（${status}）：${where}`)
  return make('CLOUD_HTTP_ERROR', `WebDAV 返回 ${status}：${where}`)
}

const joinUrl = (base, rel) => {
  const encoded = String(rel)
    .split('/')
    .filter((part) => part !== '')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return new URL(encoded, base).href
}

export class WebDavClient {
  /**
   * @param {object} opts
   * @param {string} opts.url       WebDAV 根（库目录），不强制以 / 结尾（内部会补齐）
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.retries]
   * @param {boolean} [opts.insecureTls] 自签名证书时跳过校验
   */
  constructor({ url, username = '', password = '', timeoutMs = 20_000, retries = 2, insecureTls = false } = {}) {
    if (!url) throw new LibraryError('CONFIG_INVALID', 'WebDAV 地址为空')
    const parsed = new URL(url)
    // 防御：凭据只进 Authorization，不能留在 baseUrl 里（否则会出现在状态/错误消息里）
    const urlUser = parsed.username ? decodeURIComponent(parsed.username) : ''
    const urlPass = parsed.password ? decodeURIComponent(parsed.password) : ''
    parsed.username = ''
    parsed.password = ''
    if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
    /** 根 URL（始终以 / 结尾）；拼接相对路径时按段编码。 */
    this.baseUrl = parsed.href
    this.host = parsed.host
    this.origin = `${parsed.protocol}//${parsed.host}`
    const user = username || urlUser
    const secret = password || urlPass
    this.auth = user || secret ? `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}` : ''
    this.timeoutMs = timeoutMs
    this.retries = retries
    this.insecureTls = insecureTls
  }

  /** 发一个请求，返回 `{status, headers, body}`；网络层失败抛契约错误。 */
  async request(method, rel = '', { headers = {}, body = null, maxBytes = MAX_TEXT_BYTES } = {}) {
    const target = joinUrl(this.baseUrl, rel)
    const attempts = Math.max(1, Math.min(Number(this.retries) + 1, 6))
    let last
    for (let i = 0; i < attempts; i += 1) {
      try {
        const res = await this.#once(method, target, headers, body, maxBytes)
        if ((res.status === 429 || res.status >= 500) && i + 1 < attempts) {
          last = statusError(res.status, { method, path: rel, timeoutMs: this.timeoutMs, host: this.host })
          await new Promise((r) => setTimeout(r, 200 * (i + 1)))
          continue
        }
        return res
      } catch (error) {
        const normalized = normalizeNetworkError(error, {
          method,
          path: rel,
          host: this.host,
          timeoutMs: this.timeoutMs,
        })
        last = normalized
        if (!retriable(normalized) || i + 1 >= attempts) throw normalized
        await new Promise((r) => setTimeout(r, 200 * (i + 1)))
      }
    }
    throw last ?? new LibraryError('CLOUD_NETWORK_ERROR', 'WebDAV 请求失败（未知原因）')
  }

  #once(method, target, headers, body, maxBytes) {
    return new Promise((resolve, reject) => {
      const url = new URL(target)
      const transport = url.protocol === 'https:' ? https : http
      const requestHeaders = {
        'user-agent': USER_AGENT,
        accept: '*/*',
        ...(this.auth ? { authorization: this.auth } : {}),
        ...(body ? { 'content-length': String(body.length) } : {}),
        ...headers,
      }
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      let req
      try {
        req = transport.request(
          url,
          {
            method,
            headers: requestHeaders,
            ...(url.protocol === 'https:' ? { rejectUnauthorized: !this.insecureTls } : {}),
          },
          (res) => {
            const chunks = []
            let size = 0
            res.on('data', (chunk) => {
              size += chunk.length
              if (size > maxBytes) {
                req.destroy(new LibraryError('CLOUD_RESPONSE_TOO_LARGE', `WebDAV 响应超过 ${maxBytes} 字节，已中止`))
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              if (settled) return
              settled = true
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
            })
            res.on('error', fail)
          },
        )
      } catch (error) {
        fail(error)
        return
      }
      const timer = setTimeout(() => {
        const error = new Error(`WebDAV request timeout after ${this.timeoutMs}ms`)
        error.code = 'ETIMEDOUT'
        req.destroy(error)
      }, this.timeoutMs)
      req.on('error', (error) => {
        clearTimeout(timer)
        fail(error)
      })
      req.on('close', () => clearTimeout(timer))
      if (body) req.write(body)
      req.end()
    })
  }

  /** 列一个目录（Depth: 1）。根目录 rel=''。 */
  async list(rel = '') {
    const res = await this.request('PROPFIND', rel, {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: Buffer.from(PROPFIND_BODY, 'utf8'),
    })
    if (res.status !== 207 && res.status !== 200) throw statusError(res.status, { method: 'PROPFIND', path: rel })
    // 一律相对**库根**解析：Depth:1 的响应里也会带目录自己那一条，按根解析后
    // 它就是 `rel` 本身 —— 过滤掉，否则 walk() 会把同一目录反复入队。
    return parseMultistatus(res.body.toString('utf8'), this.baseUrl).filter((entry) => entry.rel !== rel)
  }

  /** 递归列出整库：`Map<rel, {size, mtime, etag}>`。 */
  async walk({ maxFiles = 20_000, maxDepth = 12, concurrency = 4 } = {}) {
    const files = new Map()
    let frontier = ['']
    for (let depth = 0; depth <= maxDepth && frontier.length; depth += 1) {
      const next = []
      const queue = [...frontier]
      const worker = async () => {
        while (queue.length) {
          const dir = queue.shift()
          const entries = await this.list(dir)
          for (const entry of entries) {
            if (entry.isDir) {
              next.push(entry.rel)
              continue
            }
            if (files.size >= maxFiles) {
              throw new LibraryError('CLOUD_LIBRARY_TOO_LARGE', `云端文件数超过 ${maxFiles}，拒绝整库镜像`)
            }
            files.set(entry.rel, { size: entry.size, mtime: entry.mtime, etag: entry.etag })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
      frontier = next
    }
    // 触顶还剩下目录 = 结果不完整；静默返回会让"没列到的文件"在下一轮被当成远端已删。
    if (frontier.length) {
      throw new LibraryError(
        'CLOUD_LIBRARY_TOO_DEEP',
        `WebDAV 目录超过 ${maxDepth} 层（还有 ${frontier.length} 个目录没展开），拒绝用不完整的清单覆盖镜像`,
      )
    }
    return files
  }

  /** 取文件。404 映射成 `CLOUD_FILE_MISSING`（刷新时可能是"刚好被删了"，调用方会跳过）。 */
  async get(rel) {
    const res = await this.request('GET', rel, { maxBytes: MAX_FILE_BYTES })
    if (res.status === 404) throw statusError(404, { method: 'GET', path: rel })
    if (res.status < 200 || res.status >= 300) throw statusError(res.status, { method: 'GET', path: rel })
    return res.body
  }

  /** 确保 `relDir`（可多级）存在。405 = 已存在，视为成功。 */
  async ensureCollection(relDir) {
    if (!relDir) return
    const parts = relDir.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const res = await this.request('MKCOL', current, {})
      if (![200, 201, 204, 405].includes(res.status)) throw statusError(res.status, { method: 'MKCOL', path: current })
    }
  }

  /**
   * 上传（覆盖）。返回 `{status, etag}`。
   *
   * `X-OC-Mtime` 有两个作用：Nextcloud/ownCloud 用它保留修改时间；copyparty 对
   * **发了这个头的客户端**免掉卷标志 `daw`（否则同名 PUT 会被另存成
   * `note.md-<时间戳>.md`）。服务端不认识就忽略，没有副作用。
   */
  async put(rel, body, { contentType = 'text/markdown; charset=utf-8' } = {}) {
    const slash = rel.lastIndexOf('/')
    if (slash > 0) await this.ensureCollection(rel.slice(0, slash))
    const res = await this.request('PUT', rel, {
      headers: {
        'content-type': contentType,
        overwrite: 'T',
        'x-oc-mtime': String(Math.floor(Date.now() / 1000)),
      },
      body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'),
    })
    if (![200, 201, 204].includes(res.status)) throw statusError(res.status, { method: 'PUT', path: rel })
    return { status: res.status, etag: String(res.headers.etag ?? '') }
  }

  /** 删除文件/目录；404 视为已删除。 */
  async remove(rel) {
    const res = await this.request('DELETE', rel, {})
    if (![200, 202, 204, 404].includes(res.status)) throw statusError(res.status, { method: 'DELETE', path: rel })
    return res.status
  }

  /**
   * 连通性探针。**不抛**：把结果折成 `{ok, code, message, status}`，设置页直接展示。
   * @param {{write?: boolean}} [opts] write=true 时额外做一次「PUT 再删」验证写权限
   */
  async probe({ write = false } = {}) {
    const started = Date.now()
    try {
      const res = await this.request('PROPFIND', '', {
        headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
        body: Buffer.from(PROPFIND_BODY, 'utf8'),
      })
      if (res.status !== 207 && res.status !== 200) throw statusError(res.status, { method: 'PROPFIND', path: '' })
      const entries = parseMultistatus(res.body.toString('utf8'), this.baseUrl)
      const result = {
        ok: true,
        read: true,
        write: null,
        status: res.status,
        latencyMs: Date.now() - started,
        entries: entries.length,
        url: this.baseUrl,
      }
      if (write) {
        const probeName = `.dsh-probe-${Date.now().toString(36)}.txt`
        try {
          await this.put(probeName, Buffer.from('ok', 'utf8'), { contentType: 'text/plain; charset=utf-8' })
          result.write = true
        } catch (error) {
          const normalized = normalizeNetworkError(error, { method: 'PUT', path: probeName, host: this.host })
          result.write = false
          result.writeCode = normalized.code
          result.writeMessage = normalized.message
        } finally {
          try {
            await this.remove(probeName)
          } catch {
            /* 删不掉不影响结论（服务端可能开了只追加策略） */
          }
        }
      }
      return result
    } catch (error) {
      const normalized = normalizeNetworkError(error, {
        method: 'PROPFIND',
        path: '',
        host: this.host,
        timeoutMs: this.timeoutMs,
      })
      return {
        ok: false,
        read: false,
        write: null,
        code: normalized.code,
        message: normalized.message,
        status: normalized.status,
        latencyMs: Date.now() - started,
        url: this.baseUrl,
      }
    }
  }
}