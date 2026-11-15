/**
 * 精准替换：在**不重读整份内容**的前提下改大文件里的某一处（或某几处）文本。
 *
 * 为什么需要它：`library_write` 只能整份覆盖，而库里已有 `经验库/...踩坑.md`
 * 这种 22 万字节 / 2600 行的文件 —— 整份重写既贵（模型要重吐一遍全文）又危险
 * （抄漏一段就丢数据）。2026-11-06 就因此被迫用 `bash + python + 提权` 绕路，
 * 而那条路要 `danger-full-access`，本该由工具做的事不该让模型去撬沙箱。
 *
 * 语义刻意收窄到「字面量、唯一命中」：
 * - 匹配数必须恰好为 1（或显式 `all: true`），否则拒绝并列出命中行号 ——
 *   宁可不改，也不能改错地方；
 * - 不做正则、不做模糊匹配，避免「以为在改 A 实际改了 B」；
 * - 落盘仍走 publish.mjs 的原子写，安全边界与 library_write 共用同一套判定。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { LibraryError, assertRealpathInside, assertWritableTarget, resolveInside } from './paths.mjs'
import { writeAtomic } from './publish.mjs'

/** 命中过多时只回报前若干个，免得把一整段重复内容全塞回模型。 */
const MAX_REPORTED_MATCHES = 10
const PREVIEW_CHARS = 100

const preview = (s) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS)}…` : one
}

/** 把字符偏移换算成 1 基行号（大文件也只扫一次）。 */
const lineIndex = (text) => {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

const lineText = (text, line) => {
  const lines = text.split('\n')
  return preview(lines[line - 1] ?? '')
}

/**
 * 纯函数：算出替换后的文本。**不碰磁盘**，云端后端与本地后端共用这一份语义
 * （否则「本地拒绝多义命中、云端却改了」这种漂移迟早发生）。
 *
 * @param {string} before 原文
 * @param {object} opts
 * @param {boolean} [opts.all]      允许替换全部命中（默认 false：必须唯一）
 * @param {number}  [opts.count]    要求恰好匹配这么多次（与 all 同用时以 all 为准）
 * @returns {{after:string,changed:boolean,occurrences:number,
 *            matches:Array<{line:number,preview:string}>,lines:number}}
 */
export function computeReplacement(before, { oldString, newString, all = false, count } = {}) {
  if (typeof oldString !== 'string' || oldString === '') {
    throw new LibraryError('BAD_OLD_STRING', 'oldString 不能为空（要删内容请给出足够长的上下文）')
  }
  if (typeof newString !== 'string') {
    throw new LibraryError('BAD_NEW_STRING', 'newString 必须是字符串（纯删除请传空串 ""）')
  }
  if (oldString === newString) {
    throw new LibraryError('NOOP_REPLACE', 'oldString 与 newString 完全相同，这次调用不产生任何改动')
  }

  const positions = []
  let at = before.indexOf(oldString)
  while (at !== -1) {
    positions.push(at)
    at = before.indexOf(oldString, at + oldString.length)
  }

  if (!positions.length) {
    throw new LibraryError(
      'STRING_NOT_FOUND',
      `文件里找不到这段文本（文件 ${Buffer.byteLength(before)} 字节 / ${before.split('\n').length} 行）。` +
        'oldString 必须与磁盘内容逐字符一致：确认空白、缩进、全角标点、行尾；可先用 library_read + lines 取准确片段。',
    )
  }

  const toLine = lineIndex(before)
  const matches = positions
    .slice(0, MAX_REPORTED_MATCHES)
    .map((p) => ({ line: toLine(p), preview: lineText(before, toLine(p)) }))

  const want = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : undefined
  if (want && positions.length !== want) {
    throw new LibraryError(
      'MATCH_COUNT_MISMATCH',
      `期望命中 ${want} 处，实际 ${positions.length} 处（第 ${matches.map((m) => m.line).join(' / ')} 行）`,
    )
  }
  if (!all && positions.length > 1) {
    throw new LibraryError(
      'AMBIGUOUS_MATCH',
      `这段文本命中 ${positions.length} 处（第 ${matches.map((m) => m.line).join(' / ')} 行` +
        `${positions.length > MAX_REPORTED_MATCHES ? ' 等' : ''}），拒绝盲改。` +
        '请把 oldString 扩到能唯一定位（带上前后的行），或显式传 all:true 全部替换。',
    )
  }

  const after = all
    ? before.split(oldString).join(newString)
    : before.slice(0, positions[0]) + newString + before.slice(positions[0] + oldString.length)

  return {
    after,
    changed: after !== before,
    occurrences: positions.length,
    matches,
    lines: after.split('\n').length,
  }
}

/**
 * 在库内文件里把 `oldString` 换成 `newString`（本地后端）。
 *
 * @param {object} opts
 * @param {boolean} [opts.all]      允许替换全部命中（默认 false：必须唯一）
 * @param {number}  [opts.count]    要求恰好匹配这么多次（与 all 同用时以 all 为准）
 * @returns {{path:string,bytes:number,changed:boolean,occurrences:number,
 *            matches:Array<{line:number,preview:string}>,lines:number}}
 */
export function replaceInFile(root, rel, opts = {}) {
  const abs = resolveInside(root, rel)
  assertWritableTarget(abs)
  assertRealpathInside(root, abs)
  if (!existsSync(abs)) {
    throw new LibraryError('FILE_NOT_FOUND', `找不到「${rel}」；要新建请用 library_write（mode=create）`)
  }
  if (statSync(abs).isDirectory()) {
    throw new LibraryError('TARGET_IS_DIR', `${rel} 是目录，不能当文件改`)
  }

  const before = readFileSync(abs, 'utf8')
  const computed = computeReplacement(before, opts)
  const bytes = Buffer.byteLength(computed.after)
  if (!computed.changed) {
    return {
      path: rel,
      bytes,
      changed: false,
      occurrences: computed.occurrences,
      matches: computed.matches,
      lines: computed.lines,
    }
  }
  // 目标路径可能经符号链接进来（上面已拒），这里仍按真实相对路径回报，便于核对。
  writeAtomic(abs, computed.after)
  return {
    path: relative(root, abs),
    bytes,
    changed: true,
    occurrences: computed.occurrences,
    matches: computed.matches,
    lines: computed.lines,
  }
}
