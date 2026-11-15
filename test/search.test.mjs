/**
 * 检索 / 列表 / 读取 / 写入的单测 —— 全部在临时库根上跑，不碰真库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { allMarkdown, listDir, loadIndex, readFile, resolveFile, search } from '../lib/search.mjs'
import { writeFile } from '../lib/publish.mjs'
import { LibraryError } from '../lib/paths.mjs'

const doc = (fm, body) => `---\n${fm}\n---\n${body}`

function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-lib-'))
  fs.mkdirSync(path.join(root, '主题'), { recursive: true })
  fs.mkdirSync(path.join(root, '经验库'), { recursive: true })
  fs.writeFileSync(path.join(root, '00 总览.md'), doc('summary: 库首页\ndate: 2026-11-05', '# 总览\ncopyparty 是新的 WebDAV 真源'))
  fs.writeFileSync(
    path.join(root, '主题', 'copyparty 自建资料库.md'),
    doc(['summary: 用 uv 装 copyparty 替代 cf-fs', 'date: 2026-11-04', 'tags:', '  - copyparty', '  - webdav'].join('\n'), '# copyparty 主题\n\ndav-inf 必须开\ncopyparty 覆盖写需要 daw'),
  )
  fs.writeFileSync(
    path.join(root, '经验库', '踩坑.md'),
    doc(['summary: 环境结论', 'tags: [linux]'].join('\n'), '# 踩坑\n\ncopyparty 的 -ss 会打开 vague-403'),
  )
  fs.writeFileSync(path.join(root, '_index.json'), JSON.stringify({ total: 3, files: [] }))
  fs.writeFileSync(path.join(root, '_索引.md'), '# 索引')
  fs.writeFileSync(path.join(root, '.hidden.md'), doc('summary: 不该出现', '# 隐藏'))
  return root
}

const codeOf = (fn) => {
  try {
    fn()
    return undefined
  } catch (e) {
    assert.ok(e instanceof LibraryError, `期望 LibraryError，收到 ${e?.name}: ${e?.message}`)
    return e.code
  }
}

test('遍历跳过点文件与索引生成物', () => {
  const root = makeLibrary()
  const rels = allMarkdown(root).map((f) => f.rel).sort()
  assert.deepEqual(rels, ['00 总览.md', path.join('主题', 'copyparty 自建资料库.md'), path.join('经验库', '踩坑.md')].sort())
})

test('全文检索：单词命中', () => {
  const root = makeLibrary()
  const r = search(root, 'copyparty')
  assert.equal(r.total, 3)
  assert.ok(r.hits.every((h) => h.matches.length > 0))
})

test('全文检索：多词 AND（同一行内同时出现）', () => {
  const root = makeLibrary()
  const r = search(root, 'copyparty daw')
  assert.equal(r.total, 1)
  assert.equal(r.hits[0].matches.length, 1, 'AND 是按行匹配，不是按文件')
  assert.equal(r.hits[0].path, path.join('主题', 'copyparty 自建资料库.md'))
})

test('全文检索：tag 过滤', () => {
  const root = makeLibrary()
  const r = search(root, 'copyparty', { tag: 'webdav' })
  assert.equal(r.total, 1)
  assert.deepEqual(r.hits[0].tags, ['copyparty', 'webdav'])
})

test('全文检索：titlesOnly 只看 frontmatter', () => {
  const root = makeLibrary()
  const hit = search(root, '替代', { titlesOnly: true })
  assert.equal(hit.total, 1, 'summary 里有「替代」')
  const miss = search(root, 'dav-inf', { titlesOnly: true })
  assert.equal(miss.total, 0, 'dav-inf 只在正文里')
})

test('全文检索：limit 截断但 total 保留全量', () => {
  const root = makeLibrary()
  const r = search(root, 'copyparty', { limit: 2 })
  assert.equal(r.total, 3)
  assert.equal(r.hits.length, 2)
})

test('空 query 被拒', () => {
  const root = makeLibrary()
  assert.equal(codeOf(() => search(root, '   ')), 'EMPTY_QUERY')
})

test('路径片段解析：精确 / basename / 唯一包含 / 多义', () => {
  const root = makeLibrary()
  assert.equal(path.basename(resolveFile(root, '00 总览.md')), '00 总览.md')
  assert.equal(path.basename(resolveFile(root, '踩坑.md')), '踩坑.md')
  assert.equal(path.basename(resolveFile(root, '自建资料库')), 'copyparty 自建资料库.md')
  assert.equal(codeOf(() => resolveFile(root, '不存在的')), undefined, '找不到时返回 undefined 而不是抛')
  assert.equal(resolveFile(root, '不存在的'), undefined)
})

test('读取：整篇与行区间', () => {
  const root = makeLibrary()
  const whole = readFile(root, '踩坑.md')
  assert.equal(whole.frontmatter.summary, '环境结论')
  assert.equal(whole.totalLines, whole.to - whole.from + 1)
  assert.ok(whole.content.includes('vague-403'))
  const part = readFile(root, '踩坑.md', { lines: '1-2' })
  assert.equal(part.from, 1)
  assert.equal(part.to, 2)
  assert.ok(part.content.split('\n').length === 2)
})

test('读取：行号越界回退到尾部而不是报错', () => {
  const root = makeLibrary()
  const r = readFile(root, '踩坑.md', { lines: '9999' })
  assert.equal(r.from, r.totalLines)
  assert.ok(r.to >= r.from)
})

test('读取：超大文件必须指定 lines', () => {
  const root = makeLibrary()
  assert.equal(codeOf(() => readFile(root, '踩坑.md', { maxBytes: 10 })), 'FILE_TOO_LARGE')
  assert.equal(codeOf(() => readFile(root, '踩坑.md', { maxBytes: 10, lines: '1-3' })), undefined)
})

test('读取：越界路径被拒', () => {
  const root = makeLibrary()
  assert.equal(codeOf(() => readFile(root, '../../../etc/passwd')), 'PATH_ESCAPES_LIBRARY')
})

test('列表：有 dir 列该目录，无 dir 按 mtime 倒序', () => {
  const root = makeLibrary()
  const dir = listDir(root, '主题')
  assert.equal(dir.length, 1)
  assert.equal(dir[0].kind, 'file')
  assert.equal(dir[0].title, 'copyparty 主题')
  const recent = listDir(root, '', { limit: 2 })
  assert.equal(recent.length, 2)
  assert.equal(codeOf(() => listDir(root, '不存在')), 'DIR_NOT_FOUND')
})

test('索引读取：坏 JSON 返回 undefined 而不是抛', () => {
  const root = makeLibrary()
  assert.equal(loadIndex(root).total, 3)
  fs.writeFileSync(path.join(root, '_index.json'), '{ 坏掉的')
  assert.equal(loadIndex(root), undefined)
})

test('写入：新建 / 覆盖 / 内容相同短路 / create 拒绝覆盖 / append', () => {
  const root = makeLibrary()
  const created = writeFile(root, '主题/新文件.md', '# 新\n')
  assert.deepEqual({ changed: created.changed, mode: created.mode }, { changed: true, mode: 'overwrite' })
  assert.ok(fs.existsSync(path.join(root, '主题', '新文件.md')))

  const again = writeFile(root, '主题/新文件.md', '# 新\n')
  assert.equal(again.changed, false, '内容一致不应触发写盘')

  const overwritten = writeFile(root, '主题/新文件.md', '# 改过\n')
  assert.equal(overwritten.changed, true)
  assert.equal(fs.readFileSync(path.join(root, '主题', '新文件.md'), 'utf8'), '# 改过\n')

  assert.equal(codeOf(() => writeFile(root, '主题/新文件.md', 'x', { mode: 'create' })), 'FILE_EXISTS')

  writeFile(root, '主题/追加.md', 'a\n', { mode: 'append' })
  writeFile(root, '主题/追加.md', 'b\n', { mode: 'append' })
  assert.equal(fs.readFileSync(path.join(root, '主题', '追加.md'), 'utf8'), 'a\nb\n')
})

test('写入：越界 / 索引生成物 / 目录被拒', () => {
  const root = makeLibrary()
  assert.equal(codeOf(() => writeFile(root, '../evil.md', 'x')), 'PATH_ESCAPES_LIBRARY')
  assert.equal(codeOf(() => writeFile(root, '/tmp/evil.md', 'x')), 'ABSOLUTE_PATH_NOT_ALLOWED')
  assert.equal(codeOf(() => writeFile(root, '_index.json', 'x')), 'INDEX_FILE_WRITE_REFUSED')
  assert.equal(codeOf(() => writeFile(root, '_索引.md', 'x')), 'INDEX_FILE_WRITE_REFUSED')
  assert.equal(codeOf(() => writeFile(root, '主题', 'x')), 'TARGET_IS_DIR')
  assert.equal(codeOf(() => writeFile(root, 'x.md', 123)), 'BAD_CONTENT')
})

test('写入：符号链接被拒（防写穿库外）', () => {
  const root = makeLibrary()
  const outside = path.join(os.tmpdir(), `aml-outside-${process.pid}.md`)
  fs.writeFileSync(outside, 'outside\n')
  const link = path.join(root, '链接.md')
  fs.symlinkSync(outside, link)
  assert.equal(codeOf(() => writeFile(root, '链接.md', 'x')), 'SYMLINK_WRITE_REFUSED')
  fs.rmSync(outside, { force: true })
})

test('写入：不留临时文件', () => {
  const root = makeLibrary()
  writeFile(root, '主题/原子.md', '# 原子\n')
  const leftovers = fs.readdirSync(path.join(root, '主题')).filter((n) => n.startsWith('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('写入后能被检索到（同一份实现闭环）', () => {
  const root = makeLibrary()
  writeFile(root, '主题/闭环.md', doc('summary: 闭环验证', '# 闭环\n\n独特标记 zzzqqq'))
  const r = search(root, 'zzzqqq')
  assert.equal(r.total, 1)
  assert.equal(r.hits[0].path, path.join('主题', '闭环.md'))
})

test('limit：0 / 负数被钳到 1，不会把整库命中塞回模型', () => {
  const root = makeLibrary()
  const zero = search(root, 'copyparty', { limit: 0 })
  assert.equal(zero.total, 3)
  assert.equal(zero.hits.length, 1)
  const negative = search(root, 'copyparty', { limit: -5 })
  assert.equal(negative.hits.length, 1)
  const huge = search(root, 'copyparty', { limit: 10_000 })
  assert.equal(huge.hits.length, 3)
})

test('listDir：悬空符号链接只跳过该项，不让整个列表失败', () => {
  const root = makeLibrary()
  fs.symlinkSync(path.join(root, '不存在的目标.md'), path.join(root, '悬空.md'))
  const entries = listDir(root, '')
  assert.ok(entries.some((e) => e.path.includes('00 总览.md')))
  assert.equal(entries.some((e) => e.path.includes('悬空.md')), false)
})

test('readFile：超过硬上限的文件即使带 lines 也拒绝（防止整篇读进内存）', () => {
  const root = makeLibrary()
  fs.writeFileSync(path.join(root, '大文件.md'), Buffer.alloc(17 * 1024 * 1024, 0x61))
  assert.equal(codeOf(() => readFile(root, '大文件.md', { lines: '1-2' })), 'FILE_TOO_LARGE')
})
