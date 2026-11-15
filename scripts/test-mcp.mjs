#!/usr/bin/env node
/**
 * MCP 兼容层的自测：不需要任何 MCP SDK，纯 stdio 管道。
 *
 * 覆盖：
 *  1. initialize 握手（协议版本回声）
 *  2. tools/list 恰好七个工具，且工具名与 index.js 一致
 *  3. library_status 能报出真实库根
 *  4. 路径逃逸被拒（PATH_ESCAPES_LIBRARY / ABSOLUTE_PATH_NOT_ALLOWED）
 *  5. 未知工具 → -32602
 *  6. 写→读→删除 的临时文件往返（默认只在 --write 时跑，避免污染真实库）
 *
 * 用法：
 *   node scripts/test-mcp.mjs           # 只读检查
 *   node scripts/test-mcp.mjs --write    # 额外跑一次写+删的往返
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, '..', 'mcp', 'server.mjs')
const doWrite = process.argv.includes('--write')

const EXPECTED = [
  'library_search',
  'library_list',
  'library_read',
  'library_write',
  'library_replace',
  'library_publish',
  'library_status',
]

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`))

let nextId = 1
const pending = new Map()
createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line)
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000)
  })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } })
  check('initialize 握手', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const list = await rpc('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  check('七个工具齐全', EXPECTED.every((n) => names.includes(n)) && names.length === 7, names.join(','))

  const status = await rpc('tools/call', { name: 'library_status', arguments: {} })
  const sc = status.result?.structuredContent ?? {}
  check('library_status 报出库根', sc.ok === true && Boolean(sc.root), `${sc.mode} ${sc.root} (${sc.markdownFiles} md)`)

  const escape = await rpc('tools/call', { name: 'library_read', arguments: { path: '../../etc/passwd' } })
  check('相对路径逃逸被拒', escape.result?.isError === true && /PATH_ESCAPES_LIBRARY/.test(escape.result?.content?.[0]?.text ?? ''), 'PATH_ESCAPES_LIBRARY')

  const absolute = await rpc('tools/call', { name: 'library_read', arguments: { path: '/etc/passwd' } })
  check('绝对路径被拒', absolute.result?.isError === true && /ABSOLUTE_PATH_NOT_ALLOWED/.test(absolute.result?.content?.[0]?.text ?? ''), 'ABSOLUTE_PATH_NOT_ALLOWED')

  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} })
  check('未知工具 → -32602', unknown.error?.code === -32602)

  if (doWrite) {
    const p = `技能备份/_mcp-selftest-${Date.now()}.md`
    const w = await rpc('tools/call', { name: 'library_write', arguments: { path: p, content: '---\ndate: 2026-11-15\n---\n\nself-test\n', mode: 'create' } })
    check('library_write 落盘', w.result?.structuredContent?.changed === true, w.result?.structuredContent?.path)
    const r = await rpc('tools/call', { name: 'library_read', arguments: { path: p } })
    check('library_read 读回', (r.result?.structuredContent?.content ?? '').includes('self-test'))
    const rm = await rpc('tools/call', { name: 'library_replace', arguments: { path: p, oldString: 'self-test', newString: 'self-test-2' } })
    check('library_replace 生效', rm.result?.structuredContent?.changed === true)
    // 清理：用 node:fs 直接删（协议面没有 delete 工具，避免与插件语义脱节）
    const { rm: rmFile } = await import('node:fs/promises')
    const { join: j } = await import('node:path')
    await rmFile(j(sc.root, p))
    console.log(`  (已清理 ${p})`)
  }
} catch (e) {
  check('自测异常', false, String(e?.message ?? e))
} finally {
  child.stdin.end()
  child.kill()
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}