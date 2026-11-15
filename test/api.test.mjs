/**
 * 设置页的 HTTP 接口（`/api/agentmemory-library/*`）：同源栅栏、状态、试连、刷新。
 *
 * 不发真请求：req/res 用最小替身，WebDAV 用 test/helpers/fake-dav.mjs。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { createApiHandler } from '../lib/api.mjs'
import { BackendPool } from '../lib/backend.mjs'
import { inspectConfig, resolveEffective, readConfig, signatureOf } from '../lib/config.mjs'
import { startFakeDav } from './helpers/fake-dav.mjs'

const work = mkdtempSync(join(tmpdir(), 'aml-api-'))
let dav

before(async () => {
  dav = await startFakeDav()
})
after(async () => {
  await dav.close()
  rmSync(work, { recursive: true, force: true })
})

function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers }
  if (body !== null) req.push(typeof body === 'string' ? body : JSON.stringify(body))
  req.push(null)
  return req
}

function fakeRes() {
  const chunks = []
  return {
    statusCode: 200,
    headers: {},
    finished: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    end(payload) {
      this.finished = true
      if (payload !== undefined && payload !== null) chunks.push(Buffer.isBuffer(payload) ? payload.toString() : String(payload))
    },
    get text() {
      return chunks.join('')
    },
    get body() {
      try {
        return JSON.parse(this.text || '{}')
      } catch {
        return null
      }
    },
  }
}

const inspectionOf = (raw, opts = {}) => inspectConfig(raw, { legacy: null, ...opts })

const makeApi = (
  raw,
  { pool = new BackendPool({ logger: () => {} }), ctx = { get: () => undefined }, readLegacy = () => null } = {},
) => {
  let current = raw
  const api = createApiHandler({
    ctx,
    currentInspection: () => inspectionOf(current),
    pool,
    logger: () => {},
    readLegacy,
  })
  return {
    api,
    pool,
    set(next) {
      current = next
    },
    async call(req) {
      const res = fakeRes()
      await api.handle(req, res)
      return res
    },
  }
}

const localDir = join(work, 'library')
import { mkdirSync } from 'node:fs'
mkdirSync(localDir, { recursive: true })

test('status：本地模式给出生效库根、文件数、来源', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const res = await h.call(fakeReq({ url: '/api/agentmemory-library/status' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.mode, 'local')
  assert.equal(res.body.status.root, localDir)
  assert.equal(res.body.config.local.source, 'root（兼容字段）')
  assert.equal(res.body.status.publish.supported, true)
})

test('status：配置不完整时返回字段级错误（HTTP 仍是 200，前端好展示）', async () => {
  const h = makeApi({ mode: 'cloud' })
  const res = await h.call(fakeReq({ url: '/api/agentmemory-library/status' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'CONFIG_INVALID')
  assert.deepEqual(
    res.body.errors.map((e) => e.field).sort(),
    ['cloud.password', 'cloud.url', 'cloud.username'],
  )
})

test('test：本地模式目录存在 → 可读可写；不存在 → LIBRARY_ROOT_MISSING', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const ok = await h.call(
    fakeReq({ method: 'POST', url: '/api/agentmemory-library/test', body: { mode: 'local', local: { root: localDir } } }),
  )
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.read, true)
  assert.equal(ok.body.write, true)

  const missing = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'local', local: { root: join(work, 'nope') } },
    }),
  )
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'LIBRARY_ROOT_MISSING')
})

test('test：云端模式真的连一次 WebDAV（成功 / 认证失败 / 目录不存在）', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const ok = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: 'secret' } },
    }),
  )
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
  assert.equal(ok.body.mode, 'cloud')
  assert.equal(ok.body.read, true)
  assert.equal(ok.body.write, null, '默认不写探针')

  const bad = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: 'nope' } },
    }),
  )
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'CLOUD_AUTH_FAILED')

  const missing = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'cloud', cloud: { url: `${dav.origin}/nope/`, username: 'tester', password: 'secret' } },
    }),
  )
  assert.equal(missing.body.code, 'CLOUD_NOT_FOUND')

  const writeProbe = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: 'secret' }, write: true },
    }),
  )
  assert.equal(writeProbe.body.write, true)
})

test('test：草稿里没带密码时沿用已保存的密码（同一目标）', async () => {
  const raw = { mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: 'secret' } }
  const h = makeApi(raw)
  const res = await h.call(
    fakeReq({
      method: 'POST',
      url: '/api/agentmemory-library/test',
      body: { mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: '' } },
    }),
  )
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
})

test('refresh：云端强制对账并返回统计；本地模式给一句人话', async () => {
  dav.files.set('a.md', Buffer.from('A'))
  const raw = {
    mode: 'cloud',
    cloud: { url: dav.url, username: 'tester', password: 'secret', cacheDir: join(work, 'mirror-api'), refreshTtlMs: 0 },
  }
  const h = makeApi(raw)
  const res = await h.call(fakeReq({ method: 'POST', url: '/api/agentmemory-library/refresh', body: {} }))
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
  assert.equal(res.body.mode, 'cloud')
  assert.equal(res.body.result.checked, 1)
  assert.equal(res.body.status.files, 1)

  const local = makeApi({ mode: 'local', root: localDir })
  const localRes = await local.call(fakeReq({ method: 'POST', url: '/api/agentmemory-library/refresh', body: {} }))
  assert.equal(localRes.body.ok, true)
  assert.match(localRes.body.message, /本地模式/)
})

test('同源栅栏：别的站点发来的请求被 403 拒绝', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const res = await h.call(
    fakeReq({ url: '/api/agentmemory-library/status', headers: { origin: 'http://evil.example.com' } }),
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'FORBIDDEN')
})

test('信任栅栏：connection.requestRejection 返回 401 时照做', async () => {
  const h = makeApi(
    { mode: 'local', root: localDir },
    { ctx: { get: (name) => (name === 'connection' ? { requestRejection: () => 401 } : undefined) } },
  )
  const res = await h.call(fakeReq({ url: '/api/agentmemory-library/status' }))
  assert.equal(res.statusCode, 401)
  assert.equal(res.text, '')
})

test('未知子路径 → 404 JSON', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const res = await h.call(fakeReq({ url: '/api/agentmemory-library/nope' }))
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.code, 'NOT_FOUND')
})

test('坏 JSON body → 400（不再静默用已保存配置"测通了"）', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const res = await h.call(fakeReq({ method: 'POST', url: '/api/agentmemory-library/test', body: '{ broken' }))
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'BAD_BODY')
})

test('/legacy：只回 passwordSet，绝不回明文密码', async () => {
  const legacy = { path: '/tmp/x.json', url: 'https://dav/x/', username: 'u', password: 'SECRET', localRoot: '/l', insecureTls: false }
  const h = makeApi({ mode: 'local', root: localDir }, { readLegacy: () => legacy })
  const res = await h.call(fakeReq({ url: '/api/agentmemory-library/legacy?secret=1' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.passwordSet, true)
  assert.equal(res.body.password, undefined, '历史密码不能回到浏览器')
  assert.equal(JSON.stringify(res.body).includes('SECRET'), false)
})

test('没有信任栅栏时（strict 同源）：缺 Origin/Referer 的请求被拒', async () => {
  const h = makeApi({ mode: 'local', root: localDir })
  const res = await h.call(
    fakeReq({ url: '/api/agentmemory-library/status', headers: { origin: '', referer: '' } }),
  )
  assert.equal(res.statusCode, 403)
})

test('后端池：同一份配置复用实例，配置一变就换新实例（模式切换的核心）', () => {
  const pool = new BackendPool({ logger: () => {} })
  const localRaw = { mode: 'local', root: localDir }
  const localEffective = resolveEffective(readConfig(localRaw), { env: {}, legacy: null })
  const one = pool.get(localEffective, signatureOf(localEffective))
  const two = pool.get(localEffective, signatureOf(localEffective))
  assert.equal(one, two)

  const cloudEffective = resolveEffective(
    readConfig({ mode: 'cloud', cloud: { url: dav.url, username: 'tester', password: 'secret' } }),
    { env: {}, legacy: null },
  )
  const three = pool.get(cloudEffective, signatureOf(cloudEffective))
  assert.notEqual(three, one)
  assert.equal(three.mode, 'cloud')
})