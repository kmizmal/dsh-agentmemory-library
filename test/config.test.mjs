/**
 * 双模式配置层的单测：归一化、兼容字段、互斥校验、生效值优先级、签名。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CLOUD,
  MODE_CLOUD,
  MODE_LOCAL,
  inspectConfig,
  readConfig,
  resolveEffective,
  signatureOf,
  validateConfig,
  unwrap,
} from '../lib/config.mjs'
import { DEFAULT_ROOT } from '../lib/paths.mjs'

const holder = (value) => ({ get: () => value })

test('unwrap：volatile 持有器解包，普通值原样通过', () => {
  assert.equal(unwrap(holder('x')), 'x')
  assert.equal(unwrap(holder(undefined), 'fallback'), 'fallback')
  assert.equal(unwrap('y'), 'y')
  assert.equal(unwrap(undefined, 'z'), 'z')
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 })
})

test('readConfig：持有器形态（DSH 设置页写入后的 config）也能读', () => {
  const cfg = readConfig({
    mode: holder(MODE_CLOUD),
    local: { root: holder('/srv/library') },
    cloud: {
      url: holder('https://dav.example.com/lib/'),
      username: holder('u'),
      password: holder('p'),
      cacheDir: holder('/var/cache/aml'),
      refreshTtlMs: holder(5000),
      timeoutMs: holder(9000),
      retries: holder(1),
      insecureTls: holder(true),
    },
  })
  assert.equal(cfg.mode, MODE_CLOUD)
  assert.equal(cfg.local.root, '/srv/library')
  assert.equal(cfg.cloud.url, 'https://dav.example.com/lib/')
  assert.equal(cfg.cloud.refreshTtlMs, 5000)
  assert.equal(cfg.cloud.timeoutMs, 9000)
  assert.equal(cfg.cloud.retries, 1)
  assert.equal(cfg.cloud.insecureTls, true)
})

test('readConfig：缺省值 + 旧字段 root 保留', () => {
  const cfg = readConfig({ root: '/old/place' })
  assert.equal(cfg.mode, MODE_LOCAL)
  assert.equal(cfg.legacyRoot, '/old/place')
  assert.equal(cfg.local.root, '')
  assert.equal(cfg.cloud.refreshTtlMs, DEFAULT_CLOUD.refreshTtlMs)
  assert.equal(cfg.cloud.timeoutMs, DEFAULT_CLOUD.timeoutMs)
  assert.equal(cfg.cloud.retries, DEFAULT_CLOUD.retries)
  assert.equal(cfg.cloud.insecureTls, false)
  assert.equal(cfg.cloud.password, '')
})

test('readConfig：整组 local/cloud 被节点级持有器包住也能读', () => {
  const cfg = readConfig({
    mode: 'cloud',
    local: holder({ root: '/srv/lib' }),
    cloud: holder({ url: 'https://dav/x/', username: 'u', password: 'p' }),
  })
  assert.equal(cfg.local.root, '/srv/lib')
  assert.equal(cfg.cloud.url, 'https://dav/x/')
})

test('validate：URL 里带 user:pass 被拒（凭据不能进 URL）', () => {
  const cfg = readConfig({
    mode: 'cloud',
    cloud: { url: 'https://user:pass@dav.example.com/lib/', username: 'u', password: 'p' },
  })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'BAD_URL')
  assert.match(result.errors[0].message, /不要.*URL/)
})

test('readConfig：坏数字回落到默认值（不抛）', () => {
  const cfg = readConfig({ cloud: { refreshTtlMs: 'abc', timeoutMs: null } })
  assert.equal(cfg.cloud.refreshTtlMs, DEFAULT_CLOUD.refreshTtlMs)
  assert.equal(cfg.cloud.timeoutMs, DEFAULT_CLOUD.timeoutMs)
})

test('validate：本地模式只看 local.root，云端字段为空也不报错', () => {
  const cfg = readConfig({ mode: 'local', local: { root: '/srv/library' }, cloud: {} })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validate：本地模式空库根只告警（保持旧行为：走环境变量/默认路径）', () => {
  const cfg = readConfig({ mode: 'local' })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, true)
  assert.equal(result.warnings[0].code, 'LOCAL_ROOT_DEFAULTED')
})

test('validate：本地模式相对路径报错', () => {
  const cfg = readConfig({ local: { root: 'relative/dir' } })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].field, 'local.root')
  assert.equal(result.errors[0].code, 'RELATIVE_PATH')
})

test('validate：云端模式缺 url/username/password → 三个字段级错误', () => {
  const cfg = readConfig({ mode: 'cloud' })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((e) => e.field).sort(),
    ['cloud.password', 'cloud.url', 'cloud.username'],
  )
  for (const error of result.errors) assert.equal(error.code, 'REQUIRED')
})

test('validate：云端模式密码已保存时可以留空', () => {
  const cfg = readConfig({ mode: 'cloud', cloud: { url: 'https://dav/x/', username: 'u' } })
  assert.equal(validateConfig(cfg, { hasStoredPassword: true }).ok, true)
  assert.equal(validateConfig(cfg, { hasStoredPassword: false }).ok, false)
})

test('validate：WebDAV 地址协议与端口类型', () => {
  for (const url of ['ftp://dav/x', 'dav.example.com/x', 'https://']) {
    const cfg = readConfig({ mode: 'cloud', cloud: { url, username: 'u', password: 'p' } })
    const result = validateConfig(cfg, { legacy: null })
    assert.equal(result.ok, false, url)
    assert.equal(result.errors[0].field, 'cloud.url')
  }
  const ok = readConfig({ mode: 'cloud', cloud: { url: 'http://127.0.0.1:8080/dav/', username: 'u', password: 'p' } })
  assert.equal(validateConfig(ok, { legacy: null }).ok, true)
})

test('validate：数字范围与镜像目录必须是绝对路径', () => {
  const cfg = readConfig({
    mode: 'cloud',
    cloud: { url: 'https://dav/x/', username: 'u', password: 'p', cacheDir: 'cache', refreshTtlMs: 9e9, timeoutMs: 10, retries: 9 },
  })
  const result = validateConfig(cfg, { legacy: null })
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((e) => e.field).sort(),
    ['cloud.cacheDir', 'cloud.refreshTtlMs', 'cloud.retries', 'cloud.timeoutMs'],
  )
})

test('resolveEffective：local.root > root > AGENTMEMORY_ROOT > 旧配置 localRoot > 默认', () => {
  const legacy = { localRoot: '/from/legacy' }
  assert.equal(
    resolveEffective(readConfig({ local: { root: '/from/local' }, root: '/from/legacyfield' }), { env: {}, legacy }).local.root,
    '/from/local',
  )
  assert.equal(resolveEffective(readConfig({ root: '/from/legacyfield' }), { env: {}, legacy }).local.root, '/from/legacyfield')
  assert.equal(resolveEffective(readConfig({}), { env: { AGENTMEMORY_ROOT: '/from/env' }, legacy }).local.root, '/from/env')
  assert.equal(resolveEffective(readConfig({}), { env: {}, legacy }).local.root, '/from/legacy')
  assert.equal(resolveEffective(readConfig({}), { env: {}, legacy: null }).local.root, DEFAULT_ROOT)
})

test('resolveEffective：来源标签能说清"这个路径哪来的"', () => {
  const legacy = { localRoot: '/from/legacy' }
  assert.equal(resolveEffective(readConfig({ local: { root: '/a' } }), { env: {}, legacy }).local.source, 'local.root')
  assert.equal(resolveEffective(readConfig({ root: '/b' }), { env: {}, legacy }).local.source, 'root（兼容字段）')
  assert.equal(
    resolveEffective(readConfig({}), { env: { AGENTMEMORY_ROOT: '/c' }, legacy }).local.source,
    'AGENTMEMORY_ROOT',
  )
  assert.equal(
    resolveEffective(readConfig({}), { env: {}, legacy }).local.source,
    '~/.config/agentmemory-webdav.json:localRoot',
  )
  assert.equal(resolveEffective(readConfig({}), { env: {}, legacy: null }).local.source, '默认路径')
})

test('resolveEffective：云端模式不从旧配置继承密码/地址（显式配置才算）', () => {
  const effective = resolveEffective(
    readConfig({ mode: 'cloud', cloud: { url: 'https://dav/x/', username: 'u', password: 'p' } }),
    { env: {}, legacy: { url: 'https://other/', username: 'other', password: 'leak' } },
  )
  assert.equal(effective.cloud.url, 'https://dav/x/')
  assert.equal(effective.cloud.password, 'p')
  assert.equal(effective.cloud.host, 'dav')
})

test('resolveEffective：镜像目录默认按 URL 哈希，显式配置优先', () => {
  const a = resolveEffective(readConfig({ mode: 'cloud', cloud: { url: 'https://dav/a/', username: 'u', password: 'p' } }), {
    env: {},
    legacy: null,
  })
  const b = resolveEffective(readConfig({ mode: 'cloud', cloud: { url: 'https://dav/b/', username: 'u', password: 'p' } }), {
    env: {},
    legacy: null,
  })
  assert.notEqual(a.cloud.cacheDir, b.cloud.cacheDir)
  assert.match(a.cloud.cacheDir, /dsh-agentmemory-library/)
  assert.equal(a.cloud.cacheDirSource, '默认（按 URL 哈希）')

  const explicit = resolveEffective(
    readConfig({ mode: 'cloud', cloud: { url: 'https://dav/a/', username: 'u', password: 'p', cacheDir: '/var/cache/x' } }),
    { env: {}, legacy: null },
  )
  assert.equal(explicit.cloud.cacheDir, '/var/cache/x')
  assert.equal(explicit.cloud.cacheDirSource, '配置')
})

test('signatureOf：密码/地址/模式任一变化都会换后端', () => {
  const base = readConfig({ mode: 'cloud', cloud: { url: 'https://dav/a/', username: 'u', password: 'p' } })
  const one = signatureOf(resolveEffective(base, { env: {}, legacy: null }))
  const same = signatureOf(resolveEffective(base, { env: {}, legacy: null }))
  assert.equal(one, same)
  assert.notEqual(one, signatureOf(resolveEffective(readConfig({ mode: 'local' }), { env: {}, legacy: null })))
  const otherPassword = readConfig({ mode: 'cloud', cloud: { url: 'https://dav/a/', username: 'u', password: 'p2' } })
  assert.notEqual(one, signatureOf(resolveEffective(otherPassword, { env: {}, legacy: null })))
})

test('inspectConfig：一次给出 cfg / 校验 / 生效值 / 密码是否已存', () => {
  const cloud = inspectConfig(
    { mode: 'cloud', cloud: { url: 'https://dav/a/', username: 'u', password: 'p' } },
    { legacy: null },
  )
  assert.equal(cloud.ok, true)
  assert.equal(cloud.passwordSet, true)
  assert.equal(cloud.effective.mode, MODE_CLOUD)

  const broken = inspectConfig({ mode: 'cloud', cloud: { url: 'https://dav/a/' } }, { legacy: null })
  assert.equal(broken.ok, false)
  assert.equal(broken.effective, null)
  assert.equal(broken.errors.length, 2)
})