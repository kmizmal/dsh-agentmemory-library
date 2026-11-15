/**
 * 越界防护单测 —— 这是本插件唯一的安全边界，必须逐个用例钉死。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_ROOT,
  GENERATED_FILES,
  LibraryError,
  assertWritableTarget,
  resolveInside,
  resolveLibraryRoot,
} from '../lib/paths.mjs'

const mkRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-paths-'))
  fs.mkdirSync(path.join(dir, '主题'), { recursive: true })
  fs.writeFileSync(path.join(dir, '主题', 'a.md'), '# a\n')
  return dir
}

const codeOf = (fn) => {
  try {
    fn()
    return undefined
  } catch (e) {
    assert.ok(e instanceof LibraryError, `期望 LibraryError，收到 ${e?.name}`)
    return e.code
  }
}

test('默认库根指向 copyparty 真源', () => {
  assert.equal(DEFAULT_ROOT, '/root/copyparty/library/Obsidian/AgentMemory')
})

test('正常相对路径拼在根内', () => {
  const root = mkRoot()
  const abs = resolveInside(root, '主题/a.md')
  assert.equal(abs, path.join(root, '主题', 'a.md'))
  assert.equal(resolveInside(root, './主题/../主题/a.md'), path.join(root, '主题', 'a.md'))
})

test('空路径被拒', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => resolveInside(root, '')), 'EMPTY_PATH')
  assert.equal(codeOf(() => resolveInside(root, '   ')), 'EMPTY_PATH')
  assert.equal(codeOf(() => resolveInside(root, undefined)), 'EMPTY_PATH')
})

test('绝对路径被拒', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => resolveInside(root, '/etc/passwd')), 'ABSOLUTE_PATH_NOT_ALLOWED')
})

test('NUL 字节被拒', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => resolveInside(root, 'a\u0000b.md')), 'NUL_BYTE')
})

test('.. 逃逸被拒', () => {
  const root = mkRoot()
  assert.equal(codeOf(() => resolveInside(root, '..')), 'PATH_ESCAPES_LIBRARY')
  assert.equal(codeOf(() => resolveInside(root, '../evil.md')), 'PATH_ESCAPES_LIBRARY')
  assert.equal(codeOf(() => resolveInside(root, '主题/../../evil.md')), 'PATH_ESCAPES_LIBRARY')
})

test('同前缀兄弟目录不算在根内', () => {
  const root = mkRoot()
  // 用 ../<basename>-evil 构造「字符串前缀相同但不在根内」的经典陷阱
  const escaped = `../${path.basename(root)}-evil/x.md`
  assert.equal(codeOf(() => resolveInside(root, escaped)), 'PATH_ESCAPES_LIBRARY')
})

test('索引生成物禁止直写', () => {
  assert.deepEqual([...GENERATED_FILES].sort(), ['_index.json', '_索引.md'].sort())
  assert.equal(codeOf(() => assertWritableTarget('/x/_index.json')), 'INDEX_FILE_WRITE_REFUSED')
  assert.equal(codeOf(() => assertWritableTarget('/x/_索引.md')), 'INDEX_FILE_WRITE_REFUSED')
  assert.equal(codeOf(() => assertWritableTarget('/x/正常.md')), undefined)
})

test('显式 root 参数优先于环境变量', () => {
  const saved = process.env.AGENTMEMORY_ROOT
  try {
    process.env.AGENTMEMORY_ROOT = '/tmp/from-env'
    assert.equal(resolveLibraryRoot('/tmp/from-arg'), '/tmp/from-arg')
    assert.equal(resolveLibraryRoot(''), '/tmp/from-env')
    assert.equal(resolveLibraryRoot(undefined), '/tmp/from-env')
  } finally {
    if (saved === undefined) delete process.env.AGENTMEMORY_ROOT
    else process.env.AGENTMEMORY_ROOT = saved
  }
})
