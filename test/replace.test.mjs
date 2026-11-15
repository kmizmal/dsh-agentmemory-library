/**
 * 精准替换单测。
 *
 * 这个工具的失败模式比成功模式更重要：改错地方、改多处、改到索引生成物、
 * 顺着符号链接改到库外。下面每个用例都在钉死一种「宁可不改」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LibraryError } from '../lib/paths.mjs'
import { replaceInFile } from '../lib/replace.mjs'

const mkRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-replace-'))
  fs.mkdirSync(path.join(dir, '经验库'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '经验库', 'big.md'),
    ['# 大文件', '', '## §43 ASF', '', '- 上游 master 至今未修', '', '- 另一条', '', '- 上游 master 至今未修', ''].join('\n'),
  )
  fs.writeFileSync(path.join(dir, '唯一.md'), '# 唯一\n\n旧结论：升级无用\n')
  return dir
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

test('唯一命中时替换成功并回报命中行号', () => {
  const root = mkRoot()
  const r = replaceInFile(root, '唯一.md', {
    oldString: '旧结论：升级无用',
    newString: '新结论：升级无用（已修）',
  })
  assert.equal(r.changed, true)
  assert.equal(r.occurrences, 1)
  assert.equal(r.matches.length, 1)
  assert.equal(r.matches[0].line, 3)
  assert.equal(fs.readFileSync(path.join(root, '唯一.md'), 'utf8'), '# 唯一\n\n新结论：升级无用（已修）\n')
})

test('命中多处默认拒绝，并列出命中行号', () => {
  const root = mkRoot()
  const before = fs.readFileSync(path.join(root, '经验库', 'big.md'), 'utf8')
  let err
  try {
    replaceInFile(root, '经验库/big.md', { oldString: '上游 master 至今未修', newString: 'x' })
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof LibraryError)
  assert.equal(err.code, 'AMBIGUOUS_MATCH')
  assert.ok(err.message.includes('5'), err.message)
  assert.ok(err.message.includes('9'), err.message)
  assert.equal(fs.readFileSync(path.join(root, '经验库', 'big.md'), 'utf8'), before, '拒绝时不得改动文件')
})

test('all:true 替换全部命中', () => {
  const root = mkRoot()
  const r = replaceInFile(root, '经验库/big.md', { oldString: '上游 master 至今未修', newString: '已修', all: true })
  assert.equal(r.changed, true)
  assert.equal(r.occurrences, 2)
  const after = fs.readFileSync(path.join(root, '经验库', 'big.md'), 'utf8')
  assert.equal(after.split('已修').length - 1, 2)
  assert.ok(!after.includes('至今未修'))
})

test('count 不符则拒绝（含 all:true 的场合）', () => {
  const root = mkRoot()
  const before = fs.readFileSync(path.join(root, '经验库', 'big.md'), 'utf8')
  // all:true + count:3 与真实命中数 2 不符 ⇒ 拒绝，且不得改动文件
  assert.equal(
    codeOf(() => replaceInFile(root, '经验库/big.md', { oldString: '上游 master 至今未修', newString: 'x', all: true, count: 3 })),
    'MATCH_COUNT_MISMATCH',
  )
  assert.equal(fs.readFileSync(path.join(root, '经验库', 'big.md'), 'utf8'), before)
  // count 与实际一致时通过
  const ok = replaceInFile(root, '经验库/big.md', { oldString: '上游 master 至今未修', newString: 'x', all: true, count: 2 })
  assert.equal(ok.occurrences, 2)
  assert.equal(
    codeOf(() => replaceInFile(root, '唯一.md', { oldString: '旧结论：升级无用', newString: 'x', count: 2 })),
    'MATCH_COUNT_MISMATCH',
  )
})

test('找不到原文给出可操作的提示', () => {
  const root = mkRoot()
  const code = codeOf(() => replaceInFile(root, '唯一.md', { oldString: '不存在的一句话', newString: 'x' }))
  assert.equal(code, 'STRING_NOT_FOUND')
})

test('oldString 为空 / newString 非字符串 / 两侧相同 都被拒', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => replaceInFile(root, '唯一.md', { oldString: '', newString: 'x' })), 'BAD_OLD_STRING')
  assert.equal(codeOf(() => replaceInFile(root, '唯一.md', { oldString: '旧结论', newString: undefined })), 'BAD_NEW_STRING')
  assert.equal(codeOf(() => replaceInFile(root, '唯一.md', { oldString: '旧结论', newString: '旧结论' })), 'NOOP_REPLACE')
})

test('文件不存在指向 library_write', () => {
  const root = mkRoot()
  const code = codeOf(() => replaceInFile(root, '没有.md', { oldString: 'a', newString: 'b' }))
  assert.equal(code, 'FILE_NOT_FOUND')
})

test('安全边界与 library_write 共用：越界/绝对路径/索引生成物/符号链接', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => replaceInFile(root, '../逃逸.md', { oldString: 'a', newString: 'b' })), 'PATH_ESCAPES_LIBRARY')
  assert.equal(
    codeOf(() => replaceInFile(root, '/tmp/逃逸.md', { oldString: 'a', newString: 'b' })),
    'ABSOLUTE_PATH_NOT_ALLOWED',
  )
  assert.equal(codeOf(() => replaceInFile(root, '_index.json', { oldString: 'a', newString: 'b' })), 'INDEX_FILE_WRITE_REFUSED')

  const outside = path.join(root, '..', `outside-${process.pid}.md`)
  fs.writeFileSync(outside, 'outside\n')
  try {
    fs.symlinkSync(outside, path.join(root, '链接.md'))
    assert.equal(codeOf(() => replaceInFile(root, '链接.md', { oldString: 'outside', newString: 'x' })), 'SYMLINK_WRITE_REFUSED')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n', '符号链接指向的文件不得被改')
  } finally {
    fs.rmSync(outside, { force: true })
  }
})

test('大文件只改一处，其余字节原样保留', () => {
  const root = mkRoot()
  const big = path.join(root, '大.md')
  const filler = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 filler 内容`).join('\n')
  const original = `开头\n${filler}\n中间的目标句子\n${filler}\n结尾\n`
  fs.writeFileSync(big, original)
  const r = replaceInFile(root, '大.md', { oldString: '中间的目标句子', newString: '中间的已改句子' })
  assert.equal(r.changed, true)
  assert.equal(r.occurrences, 1)
  const after = fs.readFileSync(big, 'utf8')
  assert.equal(after, original.replace('中间的目标句子', '中间的已改句子'))
  assert.ok(r.lines > 10000)
})
