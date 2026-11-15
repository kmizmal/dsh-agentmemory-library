/**
 * 云端后端：镜像同步、写穿、离线降级、远端删除保护。
 *
 * 这一组测试全部打本地假 WebDAV 服务，不碰真库、不碰网络。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { CloudBackend } from '../lib/cloud.mjs'
import { readConfig, resolveEffective } from '../lib/config.mjs'
import { startFakeDav } from './helpers/fake-dav.mjs'

const work = mkdtempSync(join(tmpdir(), 'aml-cloud-'))
let counter = 0
const mirrorFor = (name) => join(work, name, 'mirror')

const backendFor = (dav, mirror, overrides = {}) => {
  const raw = {
    mode: 'cloud',
    cloud: {
      url: dav.url,
      username: 'tester',
      password: 'secret',
      cacheDir: mirror,
      refreshTtlMs: 0,
      timeoutMs: 3000,
      retries: 0,
      ...overrides,
    },
  }
  const effective = resolveEffective(readConfig(raw), { env: {}, legacy: null })
  return new CloudBackend(effective, { logger: () => {} })
}

const nextMirror = () => mirrorFor(`case-${(counter += 1)}`)

let dav
before(async () => {
  dav = await startFakeDav()
})
after(async () => {
  await dav.close()
  rmSync(work, { recursive: true, force: true })
})

const resetRemote = () => {
  dav.files.clear()
  dav.state.propfinds = 0
  dav.state.gets = 0
  dav.state.puts = 0
  dav.state.deletes = 0
  dav.state.failPut = false
  dav.state.renameOnOverwrite = false
  dav.state.normalizeCrlf = false
  dav.state.extraHrefs = []
  dav.state.failPropfind = 0
  dav.state.delayMs = 0
}

test('首次刷新：下载全部文件，检索/读取走镜像', async () => {
  resetRemote()
  dav.files.set('00 总览.md', Buffer.from('---\nsummary: 首页\n---\n# 总览\n\ncopyparty 是新的 WebDAV 真源'))
  dav.files.set('主题/copyparty.md', Buffer.from('---\nsummary: uv 装 copyparty\ntags: [copyparty, webdav]\n---\n# 主题\n\ndav-inf 必须开'))
  const backend = backendFor(dav, nextMirror())

  const found = await backend.search('copyparty')
  assert.equal(found.total, 2)
  assert.equal(found.stale, undefined)

  const read = await backend.read('00 总览.md')
  assert.equal(read.frontmatter.summary, '首页')
  assert.ok(read.content.includes('WebDAV 真源'))

  const listed = await backend.list('主题')
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].path, join('主题', 'copyparty.md').split('\\').join('/'))
  assert.ok(dav.state.gets >= 2)
})

test('TTL 内不重复对账；force 才会重新 PROPFIND', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const backend = backendFor(dav, nextMirror(), { refreshTtlMs: 60_000 })
  await backend.search('A')
  const first = dav.state.propfinds
  await backend.search('A')
  await backend.list('')
  assert.equal(dav.state.propfinds, first, 'TTL 内不该再打服务端')
  await backend.refresh({ force: true })
  assert.ok(dav.state.propfinds > first, 'force 刷新必须重新对账')
})

test('远端改动：force 刷新只重下变化的文件', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  dav.files.set('b.md', Buffer.from('B'))
  const backend = backendFor(dav, nextMirror())
  await backend.search('A')
  const getsAfterFirst = dav.state.gets
  dav.files.set('b.md', Buffer.from('B2'))
  await backend.refresh({ force: true })
  assert.equal(dav.state.gets, getsAfterFirst + 1, '只有 b.md 该被重下')
  assert.equal((await backend.search('B2')).total, 1)
})

test('远端删除：force 刷新把镜像里的文件删掉', async () => {
  resetRemote()
  dav.files.set('gone.md', Buffer.from('x'))
  dav.files.set('keep.md', Buffer.from('y'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  assert.equal(readdirSync(mirror).includes('gone.md'), true)
  dav.files.delete('gone.md')
  await backend.refresh({ force: true })
  assert.equal(readdirSync(mirror).includes('gone.md'), false)
  assert.equal(readdirSync(mirror).includes('keep.md'), true)
})

test('远端突然变空：不删镜像，只告警', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  dav.files.clear()
  const result = await backend.refresh({ force: true })
  assert.equal(result.ok, true)
  assert.equal(readdirSync(mirror).includes('a.md'), true, '不能因为远端空了就清缓存')
  assert.equal(result.failed[0].code, 'MIRROR_REMOTE_EMPTY')
})

test('写入：先 PUT 远端、再落镜像；检索立刻命中', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')

  const written = await backend.write('主题/新增.md', '---\nsummary: 新增\n---\n\n独特标记 qqqzzz', { mode: 'overwrite' })
  assert.equal(written.changed, true)
  assert.equal(written.backend, 'cloud')
  assert.equal(dav.files.get('主题/新增.md').toString('utf8').includes('qqqzzz'), true)
  assert.equal(readFileSync(join(mirror, '主题/新增.md'), 'utf8').includes('qqqzzz'), true)
  assert.equal((await backend.search('qqqzzz')).total, 1)

  // 内容相同 → changed:false，且不再 PUT
  const putsBefore = dav.state.puts
  const again = await backend.write('主题/新增.md', '---\nsummary: 新增\n---\n\n独特标记 qqqzzz', { mode: 'overwrite' })
  assert.equal(again.changed, false)
  assert.equal(dav.state.puts, putsBefore)
})

test('写入：append 语义与 create 拒绝覆盖', async () => {
  resetRemote()
  dav.files.set('log.md', Buffer.from('line1'))
  const backend = backendFor(dav, nextMirror())
  await backend.list('')

  const appended = await backend.write('log.md', 'line2', { mode: 'append' })
  assert.equal(appended.changed, true)
  assert.equal(dav.files.get('log.md').toString('utf8'), 'line1\nline2')

  await assert.rejects(() => backend.write('log.md', 'x', { mode: 'create' }), (error) => {
    assert.equal(error.code, 'FILE_EXISTS')
    return true
  })
})

test('写入失败：PUT 报错时镜像保持原样（不允许本地改了远端没有）', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('original'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  dav.state.failPut = true
  await assert.rejects(() => backend.write('a.md', 'changed', { mode: 'overwrite' }), (error) => {
    assert.equal(error.code, 'CLOUD_SERVER_ERROR')
    return true
  })
  assert.equal(readFileSync(join(mirror, 'a.md'), 'utf8'), 'original')
  assert.equal(dav.files.get('a.md').toString('utf8'), 'original')
})

test('云端也拒绝写索引进成物（_index.json / _索引.md）', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const backend = backendFor(dav, nextMirror())
  await backend.list('')
  await assert.rejects(() => backend.write('_index.json', '{}'), (error) => {
    assert.equal(error.code, 'INDEX_FILE_WRITE_REFUSED')
    return true
  })
})

test('离线：有镜像 → 读得到但带 stale 警告；无镜像 → 直接报错', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('缓存内容'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')

  // 把 URL 换成一个没人听的端口：模拟网络断了（同一份镜像还在）
  const dead = backendFor(
    { ...dav, url: 'http://127.0.0.1:1/dav/' },
    mirror,
  )
  // 第一次 refresh 会失败，随后走退避窗口
  const result = await dead.ensureFresh({ force: true })
  assert.equal(result.ok, false)
  assert.equal(result.stale, true)
  const read = await dead.read('a.md')
  assert.equal(read.stale, true)
  assert.match(read.warning.message, /上次同步的镜像/)
  assert.ok(read.content.includes('缓存内容'))

  // 空镜像 + 连不上 ⇒ 必须报错，不能装作"库里没有"
  const empty = backendFor({ ...dav, url: 'http://127.0.0.1:1/dav/' }, mirrorFor('empty-mirror'))
  await assert.rejects(() => empty.search('任何'), (error) => {
    assert.equal(error.code, 'CLOUD_UNREACHABLE')
    return true
  })
})

test('replace：云端同样走"唯一命中"语义，改完立刻能搜到', async () => {
  resetRemote()
  dav.files.set('doc.md', Buffer.from('---\nsummary: 替换\n---\n\n旧标记 zzz'))
  const backend = backendFor(dav, nextMirror())
  await backend.list('')
  const replaced = await backend.replace('doc.md', { oldString: '旧标记 zzz', newString: '新标记 yyy' })
  assert.equal(replaced.changed, true)
  assert.equal(replaced.occurrences, 1)
  assert.ok(dav.files.get('doc.md').toString('utf8').includes('新标记 yyy'))
  assert.equal((await backend.search('新标记 yyy')).total, 1)

  await assert.rejects(() => backend.replace('doc.md', { oldString: '不存在', newString: 'x' }), (error) => {
    assert.equal(error.code, 'STRING_NOT_FOUND')
    return true
  })
})

test('status：给出镜像文件数、同步时间与密码状态', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  dav.files.set('b.md', Buffer.from('B'))
  const backend = backendFor(dav, nextMirror())
  await backend.list('')
  const status = await backend.status({})
  assert.equal(status.mode, 'cloud')
  assert.equal(status.files, 2)
  assert.equal(status.markdownFiles, 2)
  assert.equal(status.passwordSet, true)
  assert.ok(status.mirror)
})

test('镜像清单写在 cacheDir 的隐藏文件里（不会被当成库内容）', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  assert.equal(readdirSync(mirror).includes('.dsh-mirror.json'), true)
  const manifest = JSON.parse(readFileSync(join(mirror, '.dsh-mirror.json'), 'utf8'))
  assert.equal(Object.keys(manifest.files).length, 1)
  // 镜像清单不是 .md，检索不会把它当内容
  assert.equal((await backend.search('dsh-mirror')).total, 0)
})

test('损坏的镜像清单：忽略并从远端重建，不抛错', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('A'))
  const mirror = nextMirror()
  mkdirSync(mirror, { recursive: true })
  writeFileSync(join(mirror, '.dsh-mirror.json'), '{ not json', { encoding: 'utf8' })
  const backend = backendFor(dav, mirror)
  const listed = await backend.list('')
  assert.equal(listed.entries.length, 1)
})

test('服务端不支持覆盖写（另存新文件名）：回读发现不一致 → CLOUD_WRITE_NOT_APPLIED，镜像不变', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('original'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  dav.state.renameOnOverwrite = true
  await assert.rejects(() => backend.write('a.md', 'changed', { mode: 'overwrite' }), (error) => {
    assert.equal(error.code, 'CLOUD_WRITE_NOT_APPLIED')
    assert.match(error.message, /另存成了新文件名|daw/)
    return true
  })
  assert.equal(readFileSync(join(mirror, 'a.md'), 'utf8'), 'original', '回读不一致时不能改镜像')
})

test('远端有、镜像没有：append 先补水再追加，create 报 FILE_EXISTS（数据丢失回归）', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('第一行\n第二行\n第三行'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  // 模拟"下载失败 / 镜像被清"但清单仍知道远端有这个文件
  rmSync(join(mirror, 'a.md'))
  const appended = await backend.write('a.md', '追加B', { mode: 'append' })
  assert.equal(appended.changed, true)
  assert.equal(
    dav.files.get('a.md').toString('utf8'),
    '第一行\n第二行\n第三行\n追加B',
    '不能把远端三行截断成"追加B"',
  )
  // 同样的状态再试 create：远端存在就必须拒绝
  rmSync(join(mirror, 'a.md'))
  await assert.rejects(() => backend.write('a.md', 'x', { mode: 'create' }), (error) => {
    assert.equal(error.code, 'FILE_EXISTS')
    return true
  })
  assert.equal(dav.files.get('a.md').toString('utf8').startsWith('第一行'), true)
})

test('远端有、镜像没有：replace 也先补水，不会把整篇覆盖成片段', async () => {
  resetRemote()
  dav.files.set('doc.md', Buffer.from('---\nsummary: x\n---\n\n旧标记 zzz\n尾巴'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  await backend.list('')
  rmSync(join(mirror, 'doc.md'))
  const replaced = await backend.replace('doc.md', { oldString: '旧标记 zzz', newString: '新标记 yyy' })
  assert.equal(replaced.changed, true)
  const remote = dav.files.get('doc.md').toString('utf8')
  assert.ok(remote.includes('新标记 yyy'))
  assert.ok(remote.includes('尾巴'), '不能被截断')
})

test('TTL 内镜像被清空：读接口会重新同步，而不是回答"库里没有"', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('内容 A'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror, { refreshTtlMs: 60_000 })
  assert.equal((await backend.search('内容')).total, 1)
  rmSync(mirror, { recursive: true, force: true })
  const again = await backend.search('内容')
  assert.equal(again.total, 1, '空镜像 + TTL 内必须重新拉，不能返回空结果')
})

test('退避窗口 + 空镜像：连续读都报错，不返回空结果', async () => {
  resetRemote()
  const backend = backendFor({ ...dav, url: 'http://127.0.0.1:1/dav/' }, nextMirror(), { refreshTtlMs: 60_000 })
  await assert.rejects(() => backend.search('x'), (error) => {
    assert.equal(error.code, 'CLOUD_UNREACHABLE')
    return true
  })
  await assert.rejects(() => backend.search('x'), (error) => {
    assert.equal(error.code, 'CLOUD_UNREACHABLE')
    return true
  })
})

test('服务端做 CRLF 归一化：按成功处理，但标 verified:false + warning', async () => {
  resetRemote()
  dav.files.set('a.md', Buffer.from('x'))
  const backend = backendFor(dav, nextMirror())
  await backend.list('')
  dav.state.normalizeCrlf = true
  const result = await backend.write('a.md', 'line1\r\nline2', { mode: 'overwrite' })
  assert.equal(result.remote.verified, false)
  assert.equal(result.warning.code, 'CLOUD_WRITE_NORMALIZED')
  assert.equal(dav.files.get('a.md').toString('utf8'), 'line1\nline2')
})

test('越界 href（编码斜杠 + ..）不会被写到镜像外', async () => {
  resetRemote()
  dav.files.set('ok.md', Buffer.from('ok'))
  const mirror = nextMirror()
  const backend = backendFor(dav, mirror)
  dav.state.extraHrefs = [`${dav.url.replace(/\/$/, '')}/a%2F..%2F..%2Fescape.md`]
  const result = await backend.refresh({ force: true })
  assert.equal(result.ok, true)
  assert.ok(result.failed.some((f) => f.code === 'PATH_ESCAPES_LIBRARY'), JSON.stringify(result.failed))
  assert.equal(existsSync(join(mirror, 'escape.md')), false)
  assert.equal(readdirSync(mirror).includes('ok.md'), true)
})
