/**
 * 库的读取面：遍历、索引、全文检索、列表、读文件。
 *
 * 打分与匹配语义逐字移植自 skill 的 search.mjs（多词 AND、逐行匹配、
 * `score = 命中行数 + 标题命中 50`），保证「插件搜到的」与「命令行搜到的」一致。
 * 区别只有一处：这里返回结构化对象而不是打印，也不再 process.exit。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { frontmatterOf } from './frontmatter.mjs'
import { LibraryError, GENERATED_FILES, resolveInside } from './paths.mjs'

export const INDEX_JSON = '_index.json'
const INDEX_MD = '_索引.md'

const skipName = (name) => name.startsWith('.') || GENERATED_FILES.has(name) || name === INDEX_MD

/**
 * 单文件硬上限：带 `lines` 时确实只需要一小段，但实现仍是整篇 readFileSync ——
 * 没有上限的话一个 500MB 的文件会把进程内存打满。超过它请用 bash/专用工具。
 */
const HARD_MAX_READ_BYTES = 16 * 1024 * 1024

/** 递归收集库内全部 .md（跳过点文件与索引生成物）。 */
export function allMarkdown(root) {
  const out = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (skipName(name)) continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      if (name.endsWith('.md')) out.push({ abs, rel: relative(root, abs), size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(root)
  return out
}

/** 读 `_index.json`（没有/坏了都返回 undefined，不致命）。 */
export function loadIndex(root) {
  try {
    return JSON.parse(readFileSync(join(root, INDEX_JSON), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 按片段解析库内文件路径：精确相对路径 → 同名 basename → 归一化包含匹配。
 * 模糊匹配到多篇时抛 AMBIGUOUS_PATH 并列出候选（与脚本的「请写得更具体」等价）。
 */
export function resolveFile(root, frag) {
  const direct = resolveInside(root, frag)
  try {
    if (statSync(direct).isFile()) return direct
  } catch {
    /* 不存在，继续模糊匹配 */
  }
  const md = allMarkdown(root)
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')
  const exact = md.find((f) => f.rel === frag)
  if (exact) return exact.abs
  const base = md.find((f) => basename(f.rel).toLowerCase() === basename(frag).toLowerCase())
  if (base) return base.abs
  const partial = md.filter((f) => norm(f.rel).includes(norm(frag)))
  if (partial.length === 1) return partial[0].abs
  if (partial.length > 1) {
    throw new LibraryError(
      'AMBIGUOUS_PATH',
      `「${frag}」匹配到 ${partial.length} 个文件，请写得更具体：${partial
        .map((f) => f.rel)
        .join(' / ')}`,
    )
  }
  return undefined
}

/**
 * 全文检索。多词 AND；`titlesOnly` 只看 frontmatter 区；`tag` 先按标签过滤。
 * @returns {{total:number, hits:Array}} hits 已按 score 降序截断到 limit
 */
export function search(root, keyword, { titlesOnly = false, tag = '', limit = 10, maxMatches = 6 } = {}) {
  const needles = String(keyword ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!needles.length) throw new LibraryError('EMPTY_QUERY', 'query 不能为空')
  const tagNeedle = String(tag ?? '').trim().toLowerCase()
  const hits = []
  for (const f of allMarkdown(root)) {
    let raw
    try {
      raw = readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    const fm = frontmatterOf(raw)
    if (tagNeedle && !fm.tags.some((t) => t.toLowerCase().includes(tagNeedle))) continue
    const head = raw.slice(0, fm.bodyStart ?? 0)
    const lines = raw.split('\n')
    const matchedLines = []
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase()
      if (needles.every((n) => low.includes(n))) matchedLines.push({ line: i + 1, text: lines[i].trim() })
    }
    if (titlesOnly) {
      const inHead = needles.every((n) => head.toLowerCase().includes(n))
      if (inHead) {
        hits.push({
          path: f.rel,
          title: fm.title || basename(f.rel),
          date: fm.date,
          tags: fm.tags,
          summary: fm.summary,
          score: 100,
          matchCount: matchedLines.length,
          matches: matchedLines.slice(0, maxMatches),
        })
      }
    } else if (matchedLines.length) {
      const inTitle = needles.every((n) => `${fm.title} ${head}`.toLowerCase().includes(n))
      hits.push({
        path: f.rel,
        title: fm.title || basename(f.rel),
        date: fm.date,
        tags: fm.tags,
        summary: fm.summary,
        score: matchedLines.length + (inTitle ? 50 : 0),
        matchCount: matchedLines.length,
        matches: matchedLines.slice(0, maxMatches),
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  // limit 必须落在 [1, 200]：0/负数/undefined 以前会"不截断"，把整库命中塞回模型。
  const raw = Number(limit)
  const cap = Number.isFinite(raw) ? Math.max(1, Math.min(Math.trunc(raw), 200)) : 0
  return { total: hits.length, hits: cap ? hits.slice(0, cap) : hits }
}

/** 列目录（带摘要）或按 mtime 列全库最近改动。 */
export function listDir(root, dirArg, { limit = 50 } = {}) {
  const items = []
  if (dirArg) {
    const dir = resolveInside(root, dirArg)
    let names
    try {
      names = readdirSync(dir).sort()
    } catch {
      throw new LibraryError('DIR_NOT_FOUND', `目录不存在：${dirArg}`)
    }
    for (const name of names) {
      if (skipName(name)) continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        // 悬空符号链接 / 权限变化：跳过这一项，不要让整个 library_list 失败
        continue
      }
      const rel = relative(root, abs)
      if (st.isDirectory()) {
        items.push({ path: rel, kind: 'dir', size: 0, mtime: st.mtimeMs })
        continue
      }
      const entry = { path: rel, kind: 'file', size: st.size, mtime: st.mtimeMs }
      if (name.endsWith('.md')) {
        try {
          const fm = frontmatterOf(readFileSync(abs, 'utf8'))
          entry.title = fm.title
          entry.summary = fm.summary
          entry.date = fm.date
          entry.tags = fm.tags
        } catch {
          /* 读不到就只给大小 */
        }
      }
      items.push(entry)
    }
    return items
  }
  // 无 dirArg：全库按 mtime 倒序（等价于脚本的「最近改动」）
  const md = allMarkdown(root)
  md.sort((a, b) => b.mtime - a.mtime)
  for (const f of md.slice(0, Number(limit) > 0 ? Number(limit) : md.length)) {
    const entry = { path: f.rel, kind: 'file', size: f.size, mtime: f.mtime }
    try {
      const fm = frontmatterOf(readFileSync(f.abs, 'utf8'))
      entry.title = fm.title
      entry.summary = fm.summary
      entry.date = fm.date
      entry.tags = fm.tags
    } catch {
      /* 忽略 */
    }
    items.push(entry)
  }
  return items
}

/** 读一段（带行号）或整篇。`lines` 形如 `"10-40"` / `"40"`。 */
export function readFile(root, frag, { lines: linesArg, maxBytes = 524288 } = {}) {
  const abs = resolveFile(root, frag)
  if (!abs) throw new LibraryError('FILE_NOT_FOUND', `找不到「${frag}」，用 library_list 看看有什么`)
  const st = statSync(abs)
  if (st.size > HARD_MAX_READ_BYTES) {
    throw new LibraryError(
      'FILE_TOO_LARGE',
      `文件 ${st.size} 字节超过硬上限 ${HARD_MAX_READ_BYTES}；请用 bash/专用工具分段读取`,
    )
  }
  const rel = relative(root, abs)
  const raw = readFileSync(abs, 'utf8')
  const fm = frontmatterOf(raw)
  const all = raw.split('\n')
  const totalLines = all.length
  let from = 1
  let to = totalLines
  if (linesArg) {
    const m = String(linesArg).match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new LibraryError('BAD_LINES', 'lines 要写成 10 或 10-40')
    const want = Number(m[1])
    from = Math.max(1, Math.min(want, totalLines))
    to = Math.min(m[2] ? Number(m[2]) : from + 30, totalLines)
    if (to < from) to = from
  } else if (st.size > maxBytes) {
    throw new LibraryError(
      'FILE_TOO_LARGE',
      `文件 ${st.size} 字节超过 maxBytes=${maxBytes}，请用 lines 指定区间`,
    )
  }
  const slice = all.slice(from - 1, to)
  return {
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    totalLines,
    from,
    to,
    frontmatter: fm,
    content: slice.map((text, i) => `${String(from + i).padStart(4)}│ ${text}`).join('\n'),
  }
}
