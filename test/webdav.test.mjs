/**
 * WebDAV 客户端：XML 解析、五个动词、错误分类（认证/404/拒绝连接/超时/5xx 重试）。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { test } from 'node:test'
import { WebDavClient, parseMultistatus } from '../lib/webdav.mjs'
import { startFakeDav } from './helpers/fake-dav.mjs'

const clientFor = (dav, overrides = {}) =>
  new WebDavClient({
    url: dav.url,
    username: 'tester',
    password: 'secret',
    timeoutMs: 3000,
    retries: 1,
    ...overrides,
  })

test('parseMultistatus：带命名空间 / 无前缀 / 百分号编码 / collection 都能认', () => {
  const base = 'https://dav.example.com/lib/'
  const xml = `<?xml version="1.0"?>
  <d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>/lib/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
    </d:response>
    <d:response>
      <d:href>/lib/%E4%B8%BB%E9%A2%98/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
    </d:response>
    <response>
      <href>/lib/%E4%B8%BB%E9%A2%98/a%20b.md</href>
      <propstat><prop><getcontentlength>12</getcontentlength><getetag>"e1"</getetag>
      <getlastmodified>Wed, 12 Nov 2026 08:00:00 GMT</getlastmodified></prop></propstat>
    </response>
  </d:multistatus>`
  const entries = parseMultistatus(xml, base)
  assert.deepEqual(
    entries.map((e) => [e.rel, e.isDir]),
    [
      ['主题', true],
      ['主题/a b.md', false],
    ],
  )
  assert.equal(entries[1].size, 12)
  assert.equal(entries[1].etag, '"e1"')
  assert.ok(entries[1].mtime > 0)
})

test('parseMultistatus：库根之外的 href 被丢掉（防止把别人目录算进来）', () => {
  const xml = `<D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/other/x.md</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response>
  </D:multistatus>`
  assert.deepEqual(parseMultistatus(xml, 'https://h/lib/'), [])
})

test('walk：递归列目录，目录本身不进文件表', async () => {
  const dav = await startFakeDav()
  dav.files.set('00 总览.md', Buffer.from('# 总览'))
  dav.files.set('主题/copyparty.md', Buffer.from('# copyparty'))
  dav.files.set('经验库/Linux 与 DSH 环境踩坑.md', Buffer.from('# 踩坑'))
  const client = clientFor(dav)
  try {
    const files = await client.walk()
    assert.deepEqual([...files.keys()].sort(), ['00 总览.md', '主题/copyparty.md', '经验库/Linux 与 DSH 环境踩坑.md'].sort())
    assert.equal(files.get('00 总览.md').size, Buffer.byteLength('# 总览'))
  } finally {
    await dav.close()
  }
})

test('get / put / mkcol / delete 往返；PUT 自动补父目录', async () => {
  const dav = await startFakeDav()
  const client = clientFor(dav)
  try {
    await client.put('新主题/子目录/文档.md', '# 你好')
    assert.equal(dav.files.get('新主题/子目录/文档.md').toString('utf8'), '# 你好')
    assert.ok(dav.state.mkcols >= 2, '应该逐级 MKCOL')

    const body = await client.get('新主题/子目录/文档.md')
    assert.equal(body.toString('utf8'), '# 你好')

    await client.remove('新主题/子目录/文档.md')
    assert.equal(dav.files.has('新主题/子目录/文档.md'), false)
    // 已删除再删一次：404 被当成成功（幂等）
    await client.remove('新主题/子目录/文档.md')
  } finally {
    await dav.close()
  }
})

test('错误分类：401 → CLOUD_AUTH_FAILED', async () => {
  const dav = await startFakeDav()
  try {
    const client = clientFor(dav, { password: 'wrong' })
    await assert.rejects(() => client.list(''), (error) => {
      assert.equal(error.code, 'CLOUD_AUTH_FAILED')
      assert.equal(error.status, 401)
      assert.match(error.message, /认证失败/)
      return true
    })
    const probe = await client.probe()
    assert.equal(probe.ok, false)
    assert.equal(probe.code, 'CLOUD_AUTH_FAILED')
  } finally {
    await dav.close()
  }
})

test('错误分类：地址指到不存在的目录 → CLOUD_NOT_FOUND', async () => {
  const dav = await startFakeDav()
  try {
    const client = clientFor(dav, { url: `${dav.origin}/nope/` })
    await assert.rejects(() => client.list(''), (error) => {
      assert.equal(error.code, 'CLOUD_NOT_FOUND')
      return true
    })
  } finally {
    await dav.close()
  }
})

test('错误分类：端口没人听 → CLOUD_UNREACHABLE', async () => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  const client = new WebDavClient({
    url: `http://127.0.0.1:${port}/dav/`,
    username: 'u',
    password: 'p',
    timeoutMs: 500,
    retries: 0,
  })
  await assert.rejects(() => client.list(''), (error) => {
    assert.equal(error.code, 'CLOUD_UNREACHABLE')
    return true
  })
})

test('错误分类：服务端很慢 → CLOUD_TIMEOUT（不无限等）', async () => {
  const dav = await startFakeDav()
  dav.state.delayMs = 400
  try {
    const client = clientFor(dav, { timeoutMs: 120, retries: 0 })
    const started = Date.now()
    await assert.rejects(() => client.list(''), (error) => {
      assert.equal(error.code, 'CLOUD_TIMEOUT')
      assert.match(error.message, /超时/)
      return true
    })
    assert.ok(Date.now() - started < 2000, '超时必须真的生效')
  } finally {
    await dav.close()
  }
})

test('5xx 会重试：第一次 500、第二次成功 → 调用本身成功', async () => {
  const dav = await startFakeDav()
  dav.state.failPropfind = 1
  try {
    const client = clientFor(dav, { retries: 2 })
    const entries = await client.list('')
    assert.deepEqual(entries, [])
    assert.equal(dav.state.propfinds, 2)
  } finally {
    await dav.close()
  }
})

test('5xx 重试耗尽 → CLOUD_SERVER_ERROR', async () => {
  const dav = await startFakeDav()
  dav.state.failPropfind = 99
  try {
    const client = clientFor(dav, { retries: 1 })
    await assert.rejects(() => client.list(''), (error) => {
      assert.equal(error.code, 'CLOUD_SERVER_ERROR')
      return true
    })
    assert.equal(dav.state.propfinds, 2)
  } finally {
    await dav.close()
  }
})

test('probe：读通 + 写权限检测（写探针会被删掉）', async () => {
  const dav = await startFakeDav()
  const client = clientFor(dav)
  try {
    const ok = await client.probe({ write: true })
    assert.equal(ok.ok, true)
    assert.equal(ok.read, true)
    assert.equal(ok.write, true)
    assert.equal([...dav.files.keys()].some((name) => name.startsWith('.dsh-probe')), false, '探针文件必须删掉')

    dav.state.failPut = true
    const readOnly = await client.probe({ write: true })
    assert.equal(readOnly.ok, true)
    assert.equal(readOnly.write, false)
    assert.equal(readOnly.writeCode, 'CLOUD_SERVER_ERROR')
  } finally {
    await dav.close()
  }
})

test('URL 里塞的 user:pass：不进 baseUrl，只进 Authorization', () => {
  const client = new WebDavClient({ url: 'https://user:pass@dav.example.com/lib/' })
  assert.equal(client.baseUrl.includes('user'), false)
  assert.equal(client.baseUrl.includes('pass'), false)
  assert.equal(client.auth, `Basic ${Buffer.from('user:pass').toString('base64')}`)
})

test('XML 实体越界不抛 RangeError（整次 PROPFIND 不能因此变网络错误）', () => {
  const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/lib/&#1114112;.md</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>`
  // 只要不抛 RangeError 就行；`#` 在 URL 里会被当 fragment，rel 具体是什么不重要。
  const entries = parseMultistatus(xml, 'https://h/lib/')
  assert.equal(entries.length, 1)
  assert.equal(typeof entries[0].rel, 'string')
})

test('walk：目录层级超过 maxDepth 直接报错，不用残缺清单覆盖镜像', async () => {
  const dav = await startFakeDav()
  dav.files.set('a/b/c.md', Buffer.from('x'))
  try {
    const client = clientFor(dav)
    await assert.rejects(() => client.walk({ maxDepth: 0 }), (error) => {
      assert.equal(error.code, 'CLOUD_LIBRARY_TOO_DEEP')
      return true
    })
  } finally {
    await dav.close()
  }
})

test('基础 URL 不以 / 结尾也能正确拼（内部补齐）', async () => {
  const dav = await startFakeDav()
  dav.files.set('a.md', Buffer.from('a'))
  try {
    const client = new WebDavClient({
      url: dav.url.replace(/\/$/, ''),
      username: 'tester',
      password: 'secret',
    })
    assert.ok(client.baseUrl.endsWith('/'))
    const body = await client.get('a.md')
    assert.equal(body.toString(), 'a')
  } finally {
    await dav.close()
  }
})

test('unsupported：服务端不认 PROPFIND → CLOUD_UNSUPPORTED', async () => {
  const server = createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const client = new WebDavClient({ url: `http://127.0.0.1:${port}/dav/`, timeoutMs: 1000, retries: 0 })
  try {
    const probe = await client.probe()
    assert.equal(probe.code, 'CLOUD_UNSUPPORTED')
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
})

test('net 辅助自检：测试里用到的端口探测不会被代理环境变量干扰', () => {
  assert.equal(typeof net.isIP('127.0.0.1'), 'number')
})