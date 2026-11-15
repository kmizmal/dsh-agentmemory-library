/**
 * 云端后端：WebDAV 是**真源**，本机目录只是镜像（缓存）。
 *
 * 为什么不是"直接用 WebDAV 做全文检索"：检索要遍历全部 .md 并逐行匹配，
 * 一次 `library_search` 打几十上百个 GET，慢且对服务端不礼貌。镜像模型把
 * 网络成本压到「每次刷新只下载变化的文件」，检索/列表/读取全部走本机 ——
 * 顺带复用了本地模式那套已经测过的实现，两种模式的行为不会漂移。
 *
 * 一致性规则（很重要，别改坏）：
 * - **写穿（write-through）**：先 PUT 到远端，回读校验通过之后才落本机镜像。
 *   PUT 失败 ⇒ 镜像不动、返回失败 —— 绝不出现"本地改了、远端没有"的分叉。
 * - **写前补水（hydrate）**：远端有、镜像没有的文件（别的客户端刚建、上次下载失败、
 *   TTL 窗口内变更），写之前先补下来；否则 append 会拿空串当原文、create 会拿"不存在"
 *   当真相，把远端整份覆盖掉。这是数据丢失级 bug，别删这段。
 * - **读可降级**：远端连不上但镜像里有内容 ⇒ 照常返回，并带
 *   `stale:true + warning`，让模型知道"这是上次同步的副本"。
 * - **镜像为空 + 连不上 ⇒ 报错**，不返回空结果（空结果会被误读成"库里没有"）。
 * - **远端突然变空 / 大批消失 ⇒ 不删本地镜像**，只告警（URL 填错/权限变化时别把缓存清空）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { LibraryError, assertRealpathInside, assertWritableTarget, resolveInside } from './paths.mjs'
import { writeAtomic, writeFile as writeLocalFile } from './publish.mjs'
import { computeReplacement } from './replace.mjs'
import { allMarkdown, listDir, readFile as readLibraryFile, search as searchLibrary } from './search.mjs'
import { WebDavClient, normalizeNetworkError } from './webdav.mjs'

const MANIFEST_NAME = '.dsh-mirror.json'
/** 镜像里超过这个数量、且远端只剩不到 20% 时，不自动删本地文件（防 URL 指错清库）。 */
const MASS_DELETE_MIN_FILES = 20
const MASS_DELETE_RATIO = 0.2

/**
 * 隐藏文件（任一路径段以 `.` 开头）不参与镜像。
 * 理由：库里的 `.sync-state.json` / `.publish-manifest.json` 是同步工具自己的状态，
 * 不参与检索（`allMarkdown` 本来就跳过点文件），镜像它们只是白花流量；
 * 而且删除清扫也跳过点文件 —— 不跳过会出现"远端删了、镜像里永远留着"。
 */
const isHidden = (rel) => rel.split('/').some((part) => part.startsWith('.'))

/** 并发执行；返回每个元素的结果（失败也占位），方便统计成功数。 */
const pMap = async (items, concurrency, fn) => {
  const queue = [...items]
  const results = new Array(queue.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor++
      const item = queue[index]
      results[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker))
  return results
}

const readManifest = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object'
      ? parsed
      : { url: '', syncedAt: 0, files: {} }
  } catch {
    return { url: '', syncedAt: 0, files: {} }
  }
}

/** 镜像里的文件清单（跳过隐藏文件与清单自身）。 */
const mirrorFiles = (root) => {
  const out = new Map()
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      out.set(relative(root, abs).split(sep).join('/'), { size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(root)
  return out
}

/** 服务端可能做换行归一化（CRLF→LF）或加 BOM；这种"等价但不逐字节相同"不算写失败。 */
const normalizeText = (buf) =>
  String(buf)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')

export class CloudBackend {
  /**
   * @param {object} effective `config.mjs` 的生效值（`mode=cloud`）
   * @param {object} [opts]
   * @param {(msg:string)=>void} [opts.logger]
   */
  constructor(effective, { logger } = {}) {
    this.mode = 'cloud'
    this.effective = effective
    this.cloud = effective.cloud
    this.mirror = effective.cloud.cacheDir
    this.log = logger ?? (() => {})
    this.client = new WebDavClient({
      url: this.cloud.url,
      username: this.cloud.username,
      password: this.cloud.password,
      timeoutMs: this.cloud.timeoutMs,
      retries: this.cloud.retries,
      insecureTls: this.cloud.insecureTls,
    })
    this.manifestPath = join(this.mirror, MANIFEST_NAME)
    this.manifest = readManifest(this.manifestPath)
    /** 最近一次成功同步的远端清单：rel → {size, mtime, etag} */
    this.remote = new Map(Object.entries(this.manifest.files ?? {}))
    this.lastSyncAt = Number(this.manifest.syncedAt) || 0
    this.lastError = null
    this.warning = null
    this.inflight = null
    this.stats = { downloaded: 0, deleted: 0, checked: 0, failed: [] }
    /** null = 还没算过；true/false 由 #hasContent() 维护。 */
    this.mirrorHasContent = null
    /** 云端模式不支持本地 publish 链路（索引/服务健康/备份都在库主机上）。 */
    this.publishSupported = false
    this.publishNote =
      '云端模式的真源在 WebDAV 服务端；_索引.md / copyparty 健康检查 / 备份时效属于**本地库主机的 publish 链路**，' +
      '请在持有 WebDAV 数据的那台机器上用本地模式跑 library_publish（或直接跑 publish.sh）'
  }

  /** 后端标识（工具结果里带出来，便于排查"到底走的哪条路"）。 */
  describe() {
    return {
      mode: 'cloud',
      url: this.cloud.url,
      host: this.cloud.host,
      mirror: this.mirror,
      root: this.mirror,
      ttl: this.cloud.refreshTtlMs,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    }
  }

  ensureReady() {
    mkdirSync(this.mirror, { recursive: true })
  }

  /** 镜像里有没有内容（.md）。决定"连不上时降级还是报错"。 */
  hasMirrorContent() {
    try {
      return allMarkdown(this.mirror).length > 0
    } catch {
      return false
    }
  }

  /**
   * 镜像里是否存在任一 .md（找到第一个就返回，不扫全库）。
   *
   * 不用缓存：镜像可能在 TTL 窗口内被清空/删掉，缓存住"有内容"会让读接口
   * 在空目录上回答"库里没有"。代价是每次读多一次目录遍历（命中即停）。
   */
  #hasContent() {
    const walk = (dir) => {
      let names
      try {
        names = readdirSync(dir)
      } catch {
        return false
      }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const abs = join(dir, name)
        let st
        try {
          st = lstatSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (walk(abs)) return true
          continue
        }
        if (name.endsWith('.md')) return true
      }
      return false
    }
    return walk(this.mirror)
  }

  /** 上一次成功对账时远端确实是空的（此时"返回空结果"才是诚实的）。 */
  #remoteKnownEmpty() {
    return Boolean(this.lastSyncAt) && this.remote.size === 0 && !this.lastError
  }

  #markStale() {
    if (!this.lastError) return
    this.warning = {
      code: this.lastError.code,
      message: `${this.lastError.message}（本次读取用的是上次同步的镜像，最后同步 ${
        this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : '从未'
      }）`,
      stale: true,
      at: this.lastError.at,
    }
  }

  /**
   * 按 TTL 刷新镜像。
   * 失败后有一个退避窗口（默认 5s–60s）：否则每个工具调用都去撞一次超时。
   *
   * ⚠️ 两条短路都必须先确认「答案是不是真的知道」：
   *   镜像为空、远端也没确认过空 ⇒ 不能短路（否则读接口会把"还没同步"答成"库里没有"）。
   *   退避窗口里同理：没内容就抛上次的错误。
   *
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, skipped?:boolean, stale?:boolean, error?:object}>}
   */
  async ensureFresh({ force = false } = {}) {
    this.ensureReady()
    const ttl = this.cloud.refreshTtlMs
    if (!force) {
      if (this.lastError) {
        const backoff = Math.max(5_000, Math.min(Math.max(ttl, 1), 60_000))
        if (Date.now() - this.lastError.at < backoff) {
          if (!this.#hasContent() && !this.#remoteKnownEmpty()) {
            throw Object.assign(new LibraryError(this.lastError.code, this.lastError.message), {
              retryAfterMs: Math.max(0, backoff - (Date.now() - this.lastError.at)),
            })
          }
          this.#markStale()
          return { ok: false, stale: true, error: this.lastError }
        }
      } else if (this.lastSyncAt && Date.now() - this.lastSyncAt < ttl) {
        // 只有"镜像有内容"或"远端已确认是空的"才允许跳过；否则继续往下刷新。
        if (this.#hasContent() || this.#remoteKnownEmpty()) return { ok: true, skipped: true }
      }
    }
    if (this.inflight) return this.inflight
    this.inflight = this.#refreshOnce().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async #refreshOnce() {
    try {
      const remote = await this.client.walk()
      const local = mirrorFiles(this.mirror)
      const failed = []
      const downloads = []

      for (const [rel, meta] of remote) {
        // 远端 href 可能带编码斜杠（`a%2F..%2F..%2Fx.md`）⇒ 解码后能逃出镜像根。
        // **先**做库内路径校验再判隐藏：`..` 本身以 `.` 开头，先判隐藏会把它悄悄吞掉，
        // 越界条目应当作为失败被看见。
        try {
          resolveInside(this.mirror, rel)
        } catch (error) {
          failed.push({ rel, code: error.code ?? 'PATH_ESCAPES_LIBRARY', message: String(error.message ?? error) })
          continue
        }
        if (isHidden(rel)) continue
        const mine = local.get(rel)
        const previous = this.remote.get(rel)
        const etagChanged = Boolean(meta.etag) && previous?.etag !== meta.etag
        const missing = !mine
        const sizeChanged = Boolean(mine) && meta.size > 0 && mine.size !== meta.size && !meta.etag
        if (missing || etagChanged || sizeChanged) downloads.push({ rel, meta })
      }

      let downloaded = 0
      await pMap(downloads, 4, async ({ rel, meta }) => {
        try {
          const body = await this.client.get(rel)
          this.#storeMirror(rel, body, { etag: meta.etag, mtime: meta.mtime })
          downloaded += 1
        } catch (error) {
          const normalized = normalizeNetworkError(error, { method: 'GET', path: rel, host: this.cloud.host })
          if (normalized.code === 'CLOUD_AUTH_FAILED' || normalized.code === 'CLOUD_FORBIDDEN') throw normalized
          failed.push({ rel, code: normalized.code, message: normalized.message })
        }
      })

      // 远端删掉的文件，镜像也跟着删；但"远端突然空了 / 大批消失"一律不删（防 URL 填错清空缓存）。
      let deleted = 0
      if (remote.size === 0 && local.size > 0) {
        failed.push({
          rel: '*',
          code: 'MIRROR_REMOTE_EMPTY',
          message: '远端此刻返回 0 个文件，为保护本地镜像暂不删除任何文件；请确认 WebDAV 地址是否指到了库目录',
        })
      } else if (local.size >= MASS_DELETE_MIN_FILES && remote.size < local.size * MASS_DELETE_RATIO) {
        failed.push({
          rel: '*',
          code: 'MIRROR_MASS_DELETE_GUARD',
          message: `远端只剩 ${remote.size} 个文件（镜像里 ${local.size} 个），疑似地址指错；本次不删除本地镜像，请人工确认`,
        })
      } else {
        for (const rel of local.keys()) {
          if (remote.has(rel)) continue
          try {
            unlinkSync(join(this.mirror, rel))
            this.remote.delete(rel)
            deleted += 1
          } catch {
            /* 删不掉就留着，下次再说 */
          }
        }
      }

      this.stats = { downloaded, deleted, checked: remote.size, failed }
      this.lastSyncAt = Date.now()
      this.lastError = null
      this.manifest = { url: this.cloud.url, syncedAt: this.lastSyncAt, files: Object.fromEntries(this.remote) }
      this.#persistManifest()
      this.mirrorHasContent = this.hasMirrorContent()
      this.warning = failed.length
        ? {
            code: failed[0].code,
            message: `${failed.length} 个文件没能同步（第一个：${failed[0].rel} — ${failed[0].message}）`,
            details: failed.slice(0, 10),
          }
        : null
      return { ok: true, ...this.stats }
    } catch (error) {
      const normalized = normalizeNetworkError(error, {
        method: 'PROPFIND',
        path: '/',
        host: this.cloud.host,
        timeoutMs: this.cloud.timeoutMs,
      })
      this.lastError = { code: normalized.code, message: normalized.message, at: Date.now() }
      this.log(`云端刷新失败：${normalized.code} ${normalized.message}`)
      if (this.#hasContent()) {
        this.#markStale()
        return { ok: false, stale: true, error: this.lastError }
      }
      throw normalized
    }
  }

  /** 供 `/api` 的「立即刷新」用：强制全量对账。 */
  refresh({ force = true } = {}) {
    return this.ensureFresh({ force })
  }

  #warn(result) {
    if (!this.warning) return result
    return { ...result, stale: this.warning.stale === true, warning: this.warning }
  }

  #mirrorAbs(rel) {
    const abs = resolveInside(this.mirror, rel)
    assertWritableTarget(abs)
    assertRealpathInside(this.mirror, abs)
    return abs
  }

  /** 把远端内容落到镜像（下载与补水共用）。 */
  #storeMirror(rel, body, meta = {}) {
    // 注意：这里**不**做 assertWritableTarget —— `_index.json` / `_索引.md` 是库里的
    // 正常内容（镜像必须带上它们给 loadIndex 用），"不许直接写生成物"只约束工具写入。
    const abs = resolveInside(this.mirror, rel)
    mkdirSync(dirname(abs), { recursive: true })
    assertRealpathInside(this.mirror, abs)
    writeAtomic(abs, body)
    this.remote.set(rel, {
      size: Buffer.byteLength(body),
      mtime: meta.mtime ?? Date.now(),
      etag: meta.etag ?? this.remote.get(rel)?.etag ?? '',
    })
    if (this.mirrorHasContent === null) this.mirrorHasContent = true
  }

  /**
   * 写之前确认"远端到底有没有这个文件"。
   *
   * 只有镜像能回答时不能信它：TTL 窗口里别的客户端新建 / 上次下载失败，镜像都可能缺文件。
   * 返回 true 表示文件存在且镜像已就绪；false 表示远端确实没有。
   */
  async #hydrate(rel) {
    const abs = resolveInside(this.mirror, rel)
    if (existsSync(abs)) return true
    if (!this.remote.has(rel)) {
      // 清单里也没有：可能是刚被别人创建（TTL 还没过）⇒ 强制对账一次。
      try {
        await this.ensureFresh({ force: true })
      } catch (error) {
        this.log(`写前对账失败（继续尝试直取）：${error?.code ?? ''} ${error?.message ?? error}`)
      }
      if (!this.remote.has(rel)) {
        // 对账后仍然没有：直接 GET 兜底（服务端可能不在 PROPFIND 里列它）。
        try {
          const body = await this.client.get(rel)
          this.#storeMirror(rel, body)
          return true
        } catch (error) {
          if (error.code === 'CLOUD_NOT_FOUND' || error.code === 'CLOUD_FILE_MISSING') {
            this.remote.delete(rel)
            return false
          }
          throw error
        }
      }
    }
    // 远端清单有、镜像没有（下载失败或镜像被清）⇒ 补下来再算。
    const body = await this.client.get(rel)
    this.#storeMirror(rel, body)
    return true
  }

  /**
   * PUT 之后的回读校验。
   *
   * 为什么必须有：有的服务端（copyparty 没开 `daw` 时）对同名 PUT 不覆盖，
   * 而是**另存成 `note.md-<时间戳>.md` 并回 201** —— 只看状态码会以为成功，
   * 实际远端原文没变、本地镜像却改了，两边永久分叉。回读一次就能当场发现。
   *
   * 分级处理：
   * - 逐字节一致 → verified:true
   * - 仅换行/BOM 归一化 → verified:false + warning（不是失败）
   * - 内容确实不一样 → CLOUD_WRITE_NOT_APPLIED（镜像不更新，提示先 read 再决定）
   * - 回读本身失败 → verified:false + warning（PUT 已 2xx，报失败会诱发重复 append）
   */
  async #verifyWrite(rel, expected) {
    const expectedBuf = Buffer.from(expected, 'utf8')
    try {
      const back = await this.client.get(rel)
      if (expectedBuf.equals(back)) return { verified: true }
      if (normalizeText(back) === normalizeText(expectedBuf)) {
        return {
          verified: false,
          verificationWarning: {
            code: 'CLOUD_WRITE_NORMALIZED',
            message: '服务端对内容做了换行/编码归一化（回读与写入原文不同但等价），已按成功处理',
          },
        }
      }
      throw new LibraryError(
        'CLOUD_WRITE_NOT_APPLIED',
        `服务端接受了 PUT，但回读「${rel}」内容不一致 —— 它很可能把这次覆盖写另存成了新文件名。` +
          'copyparty 需要卷权限 d（或卷标志 daw）才允许同名覆盖；' +
          '**先 library_read 确认远端现状再决定是否重试，不要盲目重试 append**（会重复追加）',
      )
    } catch (error) {
      if (error instanceof LibraryError && error.code === 'CLOUD_WRITE_NOT_APPLIED') throw error
      this.log(`写入回读失败（按已写入处理）：${error?.code ?? ''} ${error?.message ?? error}`)
      return {
        verified: false,
        verificationWarning: {
          code: 'CLOUD_WRITE_UNVERIFIED',
          message: `PUT 已成功，但回读校验失败（${error?.code ?? '未知'}）：${error?.message ?? error}`,
        },
      }
    }
  }

  async search(query, options = {}) {
    await this.ensureFresh()
    return this.#warn(searchLibrary(this.mirror, query, options))
  }

  async list(dir = '', options = {}) {
    await this.ensureFresh()
    return this.#warn({ entries: listDir(this.mirror, dir, options) })
  }

  async read(frag, options = {}) {
    await this.ensureFresh()
    return this.#warn(readLibraryFile(this.mirror, frag, options))
  }

  async write(rel, content, { mode = 'overwrite' } = {}) {
    if (typeof content !== 'string') throw new LibraryError('BAD_CONTENT', 'content 必须是字符串')
    await this.ensureFresh()
    // ⚠️ 必须用远端真相判断 exists，不能只看镜像（见 #hydrate 的注释）。
    const exists = await this.#hydrate(rel)
    const abs = this.#mirrorAbs(rel)
    if (mode === 'create' && exists) {
      throw new LibraryError('FILE_EXISTS', `${rel} 已存在；要改它请用 overwrite 或 append`)
    }
    if (exists && statSync(abs).isDirectory()) {
      throw new LibraryError('TARGET_IS_DIR', `${rel} 是目录，不能当文件写`)
    }
    const prev = exists ? readFileSync(abs, 'utf8') : ''
    const next =
      mode === 'append' && exists
        ? prev === '' || prev.endsWith('\n')
          ? `${prev}${content}`
          : `${prev}\n${content}`
        : content
    if (exists && next === prev) {
      return { path: rel, bytes: Buffer.byteLength(prev), changed: false, mode, backend: 'cloud' }
    }
    // 先远端、后本地：PUT 失败时镜像保持原样，不会出现"本地改了远端没有"。
    const put = await this.client.put(rel, next)
    const check = await this.#verifyWrite(rel, next)
    writeLocalFile(this.mirror, rel, next, { mode: 'overwrite' })
    this.remote.set(rel, { size: Buffer.byteLength(next), mtime: Date.now(), etag: put.etag })
    this.mirrorHasContent = null
    this.#persistManifest()
    return {
      path: rel,
      bytes: Buffer.byteLength(next),
      changed: true,
      mode,
      backend: 'cloud',
      remote: { status: put.status, etag: put.etag || undefined, verified: check.verified },
      ...(check.verificationWarning ? { warning: check.verificationWarning } : {}),
    }
  }

  async replace(rel, { oldString, newString, all = false, count } = {}) {
    await this.ensureFresh()
    const exists = await this.#hydrate(rel)
    if (!exists) {
      throw new LibraryError('FILE_NOT_FOUND', `找不到「${rel}」；云端里没有这个文件，先用 library_write 新建`)
    }
    const abs = this.#mirrorAbs(rel)
    if (statSync(abs).isDirectory()) throw new LibraryError('TARGET_IS_DIR', `${rel} 是目录，不能当文件改`)
    const before = readFileSync(abs, 'utf8')
    const computed = computeReplacement(before, { oldString, newString, all, count })
    if (!computed.changed) {
      return {
        path: rel,
        bytes: Buffer.byteLength(before),
        changed: false,
        occurrences: computed.occurrences,
        matches: computed.matches,
        lines: computed.lines,
        backend: 'cloud',
      }
    }
    const put = await this.client.put(rel, computed.after)
    const check = await this.#verifyWrite(rel, computed.after)
    writeLocalFile(this.mirror, rel, computed.after, { mode: 'overwrite' })
    this.remote.set(rel, { size: Buffer.byteLength(computed.after), mtime: Date.now(), etag: put.etag })
    this.mirrorHasContent = null
    this.#persistManifest()
    return {
      path: rel,
      bytes: Buffer.byteLength(computed.after),
      changed: true,
      occurrences: computed.occurrences,
      matches: computed.matches,
      lines: computed.lines,
      backend: 'cloud',
      remote: { status: put.status, etag: put.etag || undefined, verified: check.verified },
      ...(check.verificationWarning ? { warning: check.verificationWarning } : {}),
    }
  }

  /** 清单非原子写会在断电/并发时留下半截 JSON；复用 writeAtomic。 */
  #persistManifest() {
    this.manifest = { url: this.cloud.url, syncedAt: this.lastSyncAt, files: Object.fromEntries(this.remote) }
    try {
      writeAtomic(this.manifestPath, JSON.stringify(this.manifest))
    } catch {
      /* 清单只是加速用，写不进去下次会重新对账 */
    }
  }

  /** 状态（给 library_status 与设置页用）。不主动发网络请求，除非 `probe:true`。 */
  async status({ probe = false } = {}) {
    this.ensureReady()
    const files = mirrorFiles(this.mirror)
    const state = {
      mode: 'cloud',
      url: this.cloud.url,
      host: this.cloud.host,
      username: this.cloud.username,
      passwordSet: Boolean(this.cloud.password),
      mirror: this.mirror,
      cacheDirSource: this.effective.cloud.cacheDirSource,
      refreshTtlMs: this.cloud.refreshTtlMs,
      timeoutMs: this.cloud.timeoutMs,
      retries: this.cloud.retries,
      insecureTls: this.cloud.insecureTls,
      files: files.size,
      markdownFiles: allMarkdown(this.mirror).length,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      warning: this.warning,
      stats: this.stats,
    }
    if (probe) state.probe = await this.client.probe({ write: false })
    return state
  }
}

/** 生成镜像目录名的默认值（与 config.mjs 保持一致，仅用于展示/测试）。 */
export const defaultMirrorName = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 12)