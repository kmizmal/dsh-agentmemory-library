/**
 * 设置页用的本地 HTTP 接口（`/api/agentmemory-library/*`）。
 *
 * 为什么需要它：设置页的配置读写走 DSH 自己的 `configForms`（那份是宿主负责的，
 * 会写进 profile 补丁并支持 revision 冲突检测），但有两件事宿主不提供：
 *   1. **保存前试连**（WebDAV 地址/账号对不对，不该等到第一次写库才发现）；
 *   2. **看后端真实状态**（当前生效库根、镜像目录、上次同步时间、密码有没有存过）。
 * 另外旧配置 `~/.config/agentmemory-webdav.json` 的"一键导入"也挂在这里。
 *
 * 鉴权两道（照 dsh-bili-scroll 的实证写法）：
 * - `connection.requestRejection({headers})` —— DSH 自己的信任栅栏（认 cookie/token）；
 * - 本机同源 —— 栅栏拿不到时的兜底，也挡住浏览器里别的网页。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { LibraryError } from './paths.mjs'
import { readLegacyFile, readConfig, inspectConfig, signatureOf } from './config.mjs'
import { WebDavClient } from './webdav.mjs'

const PREFIX = '/api/agentmemory-library'
const MAX_BODY_BYTES = 1_000_000

const sendJson = (res, status, value) => {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  } catch {
    /* 连接已经断了 */
  }
}

/**
 * 读 JSON body。**不吞错误**：坏 JSON / 超限返回 `{ok:false}`，
 * 让调用方回 400 —— 否则 `/test` 会拿"空草稿"去测已保存的配置，报"测试通过"。
 */
const readBody = (req) =>
  new Promise((done) => {
    let data = ''
    let bytes = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      done(result)
    }
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        finish({ ok: false, code: 'BODY_TOO_LARGE' })
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (settled) return
      if (!data.trim()) return finish({ ok: true, value: {} })
      try {
        const value = JSON.parse(data)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return finish({ ok: false, code: 'BAD_BODY' })
        finish({ ok: true, value })
      } catch {
        finish({ ok: false, code: 'BAD_BODY' })
      }
    })
    req.on('error', () => finish({ ok: false, code: 'BAD_BODY' }))
  })

const sameOriginOk = (req, { strict = false } = {}) => {
  try {
    const host = String(req.headers.host || '')
    if (!host) return false
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    const pick = String(req.headers.origin || req.headers.referer || '')
    // 没有信任栅栏时（拿不到 connection）这一道就是唯一鉴权：
    // 必须带 Origin/Referer，否则本机任意进程伪造 Host 就能读。
    if (!pick) return !strict
    try {
      const url = new URL(pick)
      const originAuthority = String(url.host || '').toLowerCase()
      const hostAuthority = host.toLowerCase()
      if (originAuthority && originAuthority === hostAuthority) return true
      const defaultPort = url.protocol === 'https:' ? '443' : '80'
      return `${url.hostname}:${url.port || defaultPort}`.toLowerCase() === hostAuthority
    } catch {
      return false
    }
  } catch {
    return false
  }
}

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {() => object} deps.currentInspection 当前配置体检（readConfig + validate）
 * @param {object} deps.pool BackendPool
 * @param {(msg:string)=>void} [deps.logger]
 */
export function createApiHandler({ ctx, currentInspection, pool, logger, readLegacy = readLegacyFile }) {
  const log = (msg) => logger?.warn?.(msg)

  /** 信任栅栏：`{available, status}`；status undefined = 放行。 */
  const fenceStatus = (req) => {
    try {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (!connection || typeof connection.requestRejection !== 'function') return { available: false }
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection === undefined || rejection === false) return { available: true }
      return { available: true, status: typeof rejection === 'number' ? rejection : 403 }
    } catch (error) {
      log(`信任栅栏调用出错，按不通过处理：${error?.message ?? error}`)
      return { available: true, status: 403 }
    }
  }

  const inspectDraft = (body) => {
    const live = currentInspection()
    const draft = {
      mode: body.mode ?? live.cfg.mode,
      root: body.root ?? live.cfg.legacyRoot,
      local: { root: body.local?.root ?? live.cfg.local.root },
      cloud: {
        url: body.cloud?.url ?? live.cfg.cloud.url,
        username: body.cloud?.username ?? live.cfg.cloud.username,
        // 密码不回显给浏览器；草稿里没带就沿用已保存的那份（只在目标相同的情况下）
        password:
          body.cloud?.password ||
          (String(body.cloud?.url ?? live.cfg.cloud.url) === live.cfg.cloud.url ? live.cfg.cloud.password : ''),
        cacheDir: body.cloud?.cacheDir ?? live.cfg.cloud.cacheDir,
        refreshTtlMs: body.cloud?.refreshTtlMs ?? live.cfg.cloud.refreshTtlMs,
        timeoutMs: body.cloud?.timeoutMs ?? live.cfg.cloud.timeoutMs,
        retries: body.cloud?.retries ?? live.cfg.cloud.retries,
        insecureTls: body.cloud?.insecureTls ?? live.cfg.cloud.insecureTls,
      },
    }
    return inspectConfig(draft, { legacy: readLegacy(), hasStoredPassword: live.passwordSet })
  }

  const backendOf = (effective) => pool.get(effective, signatureOf(effective))

  const statusPayload = async ({ probe = false } = {}) => {
    const inspection = currentInspection()
    const configView = {
      mode: inspection.cfg.mode,
      local: {
        configured: inspection.cfg.local.root || inspection.cfg.legacyRoot || '',
        effectiveRoot: inspection.effective?.local.root ?? null,
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
      publish: { script: inspection.cfg.publish.script, timeoutMs: inspection.cfg.publish.timeoutMs },
    }
    if (!inspection.ok) {
      return { ok: false, code: 'CONFIG_INVALID', config: configView, errors: inspection.errors }
    }
    const backend = backendOf(inspection.effective)
    let status
    try {
      status = await backend.status({ probe })
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? 'STATUS_FAILED',
        message: String(error?.message ?? error),
        config: configView,
        mode: inspection.cfg.mode,
      }
    }
    return { ok: true, mode: inspection.cfg.mode, config: configView, status }
  }

  const testDraft = async (body) => {
    const inspection = inspectDraft(body)
    if (!inspection.ok) {
      return { ok: false, code: 'CONFIG_INVALID', errors: inspection.errors, warnings: inspection.warnings }
    }
    const started = Date.now()
    if (inspection.cfg.mode === 'local') {
      const root = resolve(inspection.effective.local.root)
      if (!existsSync(root)) {
        return {
          ok: false,
          mode: 'local',
          code: 'LIBRARY_ROOT_MISSING',
          message: `目录不存在：${root}`,
          latencyMs: Date.now() - started,
        }
      }
      if (!statSync(root).isDirectory()) {
        return { ok: false, mode: 'local', code: 'NOT_A_DIRECTORY', message: `不是目录：${root}`, latencyMs: Date.now() - started }
      }
      let write = true
      try {
        accessSync(root, constants.W_OK)
      } catch {
        write = false
      }
      return { ok: true, mode: 'local', read: true, write, path: root, latencyMs: Date.now() - started }
    }
    const client = new WebDavClient({
      url: inspection.effective.cloud.url,
      username: inspection.effective.cloud.username,
      password: inspection.effective.cloud.password,
      timeoutMs: inspection.effective.cloud.timeoutMs,
      retries: inspection.effective.cloud.retries,
      insecureTls: inspection.effective.cloud.insecureTls,
    })
    const result = await client.probe({ write: body.write === true })
    return { mode: 'cloud', ...result }
  }

  const route = async (req, res, url) => {
    const path = url.pathname.slice(PREFIX.length) || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && (path === '/' || path === '/status')) {
      const probe = url.searchParams.get('probe') === '1' || url.searchParams.get('probe') === 'true'
      return sendJson(res, 200, await statusPayload({ probe }))
    }

    if (method === 'POST' && path === '/test') {
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, code: body.code, message: '请求体不是合法 JSON' })
      try {
        return sendJson(res, 200, await testDraft(body.value))
      } catch (error) {
        return sendJson(res, 200, {
          ok: false,
          code: error?.code ?? 'TEST_FAILED',
          message: String(error?.message ?? error),
        })
      }
    }

    if (method === 'POST' && path === '/refresh') {
      const inspection = currentInspection()
      if (!inspection.ok) {
        return sendJson(res, 200, { ok: false, code: 'CONFIG_INVALID', errors: inspection.errors })
      }
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, code: body.code, message: '请求体不是合法 JSON' })
      const backend = backendOf(inspection.effective)
      if (inspection.cfg.mode !== 'cloud') {
        return sendJson(res, 200, {
          ok: true,
          mode: 'local',
          message: '本地模式没有镜像；直接读的就是磁盘',
          status: await backend.status({ probe: body.value?.probe === true }),
        })
      }
      try {
        const result = await backend.refresh({ force: true })
        return sendJson(res, 200, {
          ok: result.ok !== false,
          mode: 'cloud',
          result,
          status: await backend.status({ probe: false }),
        })
      } catch (error) {
        return sendJson(res, 200, {
          ok: false,
          mode: 'cloud',
          code: error?.code ?? 'REFRESH_FAILED',
          message: String(error?.message ?? error),
        })
      }
    }

    if (method === 'GET' && path === '/legacy') {
      const legacy = readLegacy()
      if (!legacy) {
        return sendJson(res, 200, { ok: true, found: false, message: '没有找到 ~/.config/agentmemory-webdav.json' })
      }
      // 🔴 绝不回传密码：宿主已经把 role('secret') 字段脱敏成只写，
      //    这里再把历史明文吐回去等于绕开脱敏。只告诉"有没有"。
      return sendJson(res, 200, {
        ok: true,
        found: true,
        path: legacy.path,
        url: legacy.url,
        username: legacy.username,
        localRoot: legacy.localRoot,
        insecureTls: legacy.insecureTls,
        passwordSet: Boolean(legacy.password),
      })
    }

    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `没有这个接口：${method} ${path}` })
  }

  return {
    async handle(req, res) {
      const fence = fenceStatus(req)
      if (fence.status !== undefined) {
        try {
          res.statusCode = fence.status
          res.end()
        } catch {
          /* 忽略 */
        }
        return
      }
      if (!sameOriginOk(req, { strict: !fence.available })) {
        return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只接受本机同源请求' })
      }
      let url
      try {
        url = new URL(req.url, 'http://127.0.0.1')
      } catch {
        return sendJson(res, 400, { ok: false, code: 'BAD_URL' })
      }
      if (!url.pathname.startsWith(PREFIX)) {
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
      }
      try {
        await route(req, res, url)
      } catch (error) {
        log(`接口出错：${error?.message ?? error}`)
        sendJson(res, 500, {
          ok: false,
          code: error instanceof LibraryError ? error.code : 'INTERNAL_ERROR',
          message: String(error?.message ?? error),
        })
      }
    },
  }
}