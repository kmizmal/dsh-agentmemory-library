/**
 * frontmatter 解析单测 —— 覆盖库里真实用到的几种写法。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY_FM, frontmatterOf } from '../lib/frontmatter.mjs'

const doc = (fm, body) => `---\n${fm}\n---\n${body}`

test('没有 frontmatter 时返回空壳', () => {
  const fm = frontmatterOf('# 标题\n正文')
  assert.equal(fm.title, '') // 无 frontmatter 就不解析 body，与脚本行为一致
  assert.deepEqual(fm.tags, [])
  assert.equal(fm.bodyStart, 0)
  assert.equal(frontmatterOf('').bodyStart, 0)
  assert.equal(frontmatterOf(undefined).bodyStart, 0)
})

test('未闭合的 --- 视为无 frontmatter', () => {
  assert.equal(frontmatterOf('---\nsummary: x\n').bodyStart, 0)
})

test('基本键与 title 提取', () => {
  const raw = doc(
    ['summary: 一句话结论', 'date: 2026-11-05', 'project: dsh'].join('\n'),
    '# 真标题\n\n正文',
  )
  const fm = frontmatterOf(raw)
  assert.equal(fm.summary, '一句话结论')
  assert.equal(fm.date, '2026-11-05')
  assert.equal(fm.project, 'dsh')
  assert.equal(fm.title, '真标题')
  assert.ok(fm.bodyStart > 0)
})

test('description 视同 summary', () => {
  assert.equal(frontmatterOf(doc('description: 描述文字', '# t')).summary, '描述文字')
})

test('行内 tags 数组与 YAML 列表两种写法', () => {
  const inline = frontmatterOf(doc('tags: [技术/hid, 排障]', '# t'))
  assert.deepEqual(inline.tags, ['技术/hid', '排障'])
  const block = frontmatterOf(doc(['tags:', '  - 技术/hid', '  - 排障'].join('\n'), '# t'))
  assert.deepEqual(block.tags, ['技术/hid', '排障'])
})

test('行内 tags 的方括号与空格被清干净', () => {
  const fm = frontmatterOf(doc('tags: [ 时间线 , agentmemory/时间线,webdav ]', '# t'))
  assert.deepEqual(fm.tags, ['时间线', 'agentmemory/时间线', 'webdav'])
})

test('带冒号的 tag 被过滤（避免把 k: v 误当标签）', () => {
  const fm = frontmatterOf(doc(['tags:', '  - a:b', '  - ok'].join('\n'), '# t'))
  assert.deepEqual(fm.tags, ['ok'])
})

test('折叠块 >- 与 | 收集续行', () => {
  const folded = frontmatterOf(doc(['summary: >-', '  第一行', '  第二行'].join('\n'), '# t'))
  assert.equal(folded.summary, '第一行 第二行')
  const block = frontmatterOf(doc(['summary: |', '  甲', '  乙'].join('\n'), '# t'))
  assert.equal(block.summary, '甲 乙')
})

test('引号被剥掉', () => {
  assert.equal(frontmatterOf(doc('summary: "带引号"', '# t')).summary, '带引号')
  assert.equal(frontmatterOf(doc("summary: '单引号'", '# t')).summary, '单引号')
})

test('tags 去重且 EMPTY_FM 不被污染', () => {
  const fm = frontmatterOf(doc(['tags:', '  - x', '  - x'].join('\n'), '# t'))
  assert.deepEqual(fm.tags, ['x'])
  assert.deepEqual(EMPTY_FM.tags, [], '空壳常量必须保持干净')
})
