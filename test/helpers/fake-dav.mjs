/**
 * 测试用的最小 WebDAV 服务端（内存版）。
 *
 * 只实现插件真正用到的五个动词：PROPFIND / GET / PUT / MKCOL / DELETE。
 * 目的不是"实现一个正确的 DAV"，而是把**契约边界**钉死：认证、404、500、
 * 超时、目录列表的 XML 形状。真实服务端（copyparty / nginx-dav / Nextcloud）
 * 的差异由 `test/webdav.test.mjs` 里的注释记录。
 */
import http from 'node:http'

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const b64 = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`

/**
 * @param {object} [opts]
 * @param {string} [opts.user]
 * @param {string} [opts.pass]
 * @param {string} [opts.prefix] 服务器上的库根路径，例如 '/dav/'
 * @returns {Promise<{origin:string, url:string, files:Map<string,Buffer>, state:object, close:()=>Promise<void>}>}
 */
export async function startFakeDav({ user = 'tester', pass = 'secret', prefix = '/dav/' } = {}) {
  const files = new Map() // rel -> Buffer
  const dirs = new Set([''])
  const state = {
    auth: b64(user, pass),
    propfinds: 0,
    gets: 0,
    puts: 0,
    mkcols: 0,
    deletes: 0,
    failPut: false,
    /** 模拟 copyparty 没开 daw：同名 PUT 不覆盖，另存成 <name>-<ts>.md，仍回 201 */
    renameOnOverwrite: false,
    /** 模拟服务端做换行归一化：PUT 时把 CRLF 换成 LF */
    normalizeCrlf: false,
    /** 额外塞进 PROPFIND 的原始 href（测越界路径过滤） */
    extraHrefs: [],
    failPropfind: 0,
    delayMs: 0,
    lastAuth: null,
    requests: [],
  }

  const ensureDirs = (rel) => {
    const parts = rel.split('/').slice(0, -1)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      dirs.add(current)
    }
  }

  const href = (rel) => `${prefix}${rel.split('/').map(encodeURIComponent).join('/')}${rel ? '' : ''}`

  const entryXml = (rel, isDir, buf) => {
    const self = rel === '' ? prefix : href(rel)
    return [
      '<D:response>',
      `<D:href>${xmlEscape(self)}</D:href>`,
      '<D:propstat><D:prop>',
      isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
      isDir ? '' : `<D:getcontentlength>${buf.length}</D:getcontentlength>`,
      isDir ? '' : '<D:getlastmodified>Wed, 12 Nov 2026 08:00:00 GMT</D:getlastmodified>',
      isDir ? '' : `<D:getetag>"${buf.length}-${hash(buf)}"</D:getetag>`,
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
      '</D:response>',
    ]
      .filter(Boolean)
      .join('')
  }

  const hash = (buf) => {
    let h = 0
    for (const byte of buf) h = (h * 31 + byte) % 1_000_003
    return h.toString(36)
  }

  const childrenOf = (rel) => {
    const out = new Set()
    for (const name of files.keys()) {
      if (rel === '') {
        const head = name.split('/')[0]
        if (head !== name) out.add(head)
        else out.add(name)
      } else if (name.startsWith(`${rel}/`)) {
        const rest = name.slice(rel.length + 1)
        const head = rest.split('/')[0]
        out.add(rest.includes('/') ? `${rel}/${head}` : name)
      }
    }
    for (const dir of dirs) {
      if (!dir || dir === rel) continue
      if (rel === '' && !dir.includes('/')) out.add(dir)
      else if (rel && dir.startsWith(`${rel}/`) && !dir.slice(rel.length + 1).includes('/')) out.add(dir)
    }
    return [...out].sort()
  }

  const server = http.createServer(async (req, res) => {
    state.requests.push(`${req.method} ${req.url}`)
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
    if (req.headers.authorization !== state.auth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' })
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      pathname = url.pathname
    }
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404)
      res.end()
      return
    }
    const rel = pathname.slice(prefix.length).replace(/\/+$/, '')
    const method = req.method

    if (method === 'PROPFIND') {
      state.propfinds += 1
      if (state.failPropfind > 0) {
        state.failPropfind -= 1
        res.writeHead(500)
        res.end('boom')
        return
      }
      const isDir = rel === '' || dirs.has(rel) || [...files.keys()].some((name) => name.startsWith(`${rel}/`))
      if (!isDir && !files.has(rel)) {
        res.writeHead(404)
        res.end()
        return
      }
      const depth = String(req.headers.depth ?? '0')
      const rows = []
      if (isDir) {
        rows.push(entryXml(rel, true, Buffer.alloc(0)))
        if (depth !== '0') {
          for (const child of childrenOf(rel)) {
            const childIsDir = dirs.has(child) || !files.has(child)
            rows.push(entryXml(child, childIsDir, childIsDir ? Buffer.alloc(0) : files.get(child)))
          }
        }
      } else {
        rows.push(entryXml(rel, false, files.get(rel)))
      }
      for (const raw of state.extraHrefs) {
        rows.push(
          `<D:response><D:href>${xmlEscape(raw)}</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response>`,
        )
      }
      const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      res.end(body)
      return
    }

    if (method === 'GET') {
      state.gets += 1
      const buf = files.get(rel)
      if (!buf) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
      res.end(buf)
      return
    }

    if (method === 'PUT') {
      state.puts += 1
      if (state.failPut) {
        res.writeHead(500)
        res.end('boom')
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let buf = Buffer.concat(chunks)
      if (state.normalizeCrlf) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      ensureDirs(rel)
      const target = state.renameOnOverwrite && files.has(rel) ? `${rel}-${Date.now().toString(36)}.md` : rel
      files.set(target, buf)
      res.writeHead(201, { etag: `"${buf.length}-${hash(buf)}"` })
      res.end()
      return
    }

    if (method === 'MKCOL') {
      state.mkcols += 1
      if (dirs.has(rel)) {
        res.writeHead(405)
        res.end()
        return
      }
      if (files.has(rel)) {
        res.writeHead(405)
        res.end()
        return
      }
      ensureDirs(`${rel}/x`)
      dirs.add(rel)
      res.writeHead(201)
      res.end()
      return
    }

    if (method === 'DELETE') {
      state.deletes += 1
      if (files.delete(rel) || dirs.delete(rel)) {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
      return
    }

    res.writeHead(405)
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    url: `${origin}${prefix}`,
    files,
    dirs,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}