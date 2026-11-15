/**
 * frontmatter 解析：逐字移植自
 * /root/.agents/skills/agentmemory-library/scripts/search.mjs 的 frontmatterOf()。
 *
 * 不引第三方 YAML 解析器是刻意的：库里 172 篇 md 的 frontmatter 是固定几个键
 * （summary/description、date、project、tags），而第三方库对 `>-` 折叠块、
 * 未加引号的中文、行内 tags 的处理各有差异。两边用同一份实现，检索结果才不会
 * 在插件与脚本之间漂移。
 */

export const EMPTY_FM = { tags: [], summary: '', date: '', title: '', bodyStart: 0 }

export function frontmatterOf(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('---')) return { ...EMPTY_FM, tags: [] }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return { ...EMPTY_FM, tags: [] }
  const fm = raw.slice(4, end)
  const out = { tags: [], summary: '', date: '', title: '', project: '' }
  const lines = fm.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue
    const [, key, rest] = m
    let val = rest.trim()
    if (!val || ['>', '|', '>-', '|-', '>+', '|+'].includes(val)) {
      const buf = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_][\w-]*:/.test(lines[j]) || !lines[j].trim()) break
        buf.push(lines[j].trim())
      }
      val = buf.join(' ')
    }
    val = val.replace(/^["']|["']$/g, '')
    if (key === 'summary' || key === 'description') out.summary = val
    else if (key === 'date') out.date = val
    else if (key === 'project') out.project = val
    else if (key === 'tags') {
      if (val && !val.startsWith('-')) {
        // 行内数组 `tags: [a, b]` 按逗号拆开。scripts/search.mjs 与 sync.mjs 把整串
        // 当成一个 tag（`["[时间线, WeFlow, MCP]"]`），于是 --tag 对 55 篇行内写法的
        // 文件全都无效；插件这边拆开，属于有意修正，见 README「与脚本的已知差异」。
        const inline = val.replace(/^\[|\]$/g, '')
        for (const part of inline.split(',')) {
          const t = part.trim()
          if (t) out.tags.push(t)
        }
      }
    }
  }
  const tagSection = fm.match(/^tags:\s*\n((?:\s*-\s+.+\n?)+)/m)
  if (tagSection) {
    for (const t of tagSection[1].split('\n')) {
      const v = t.replace(/^\s*-\s+/, '').trim()
      if (v) out.tags.push(v)
    }
  }
  out.tags = [...new Set(out.tags.filter((t) => t && !t.includes(':')))]
  const body = raw.slice(end + 4)
  const h1 = body.match(/^#\s+(.+)$/m)
  if (h1) out.title = h1[1].trim()
  out.bodyStart = end + 4
  return out
}
