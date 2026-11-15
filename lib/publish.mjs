/**
 * 写入与收尾。
 *
 * 写入：原子写（同目录临时文件 + rename），内容完全相同则短路（`changed:false`），
 * 免得模型重复写同一段文本把 mtime 刷得满库都是"刚改动"。
 *
 * 收尾：spawn 现成的 publish.sh —— 不重写它。那份脚本管着
 * `sync.mjs --index` + copyparty 健康检查 + 备份时效三件事，cron 也在用它，
 * 保持单一实现比在插件里复刻一遍更安全。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LibraryError, assertRealpathInside, assertWritableTarget, resolveInside } from './paths.mjs'

const TAIL_BYTES = 2000
const DEFAULT_TIMEOUT_MS = 120_000

const tail = (s) => {
  const t = String(s ?? '')
  return t.length > TAIL_BYTES ? `…${t.slice(-TAIL_BYTES)}` : t
}

/**
 * 写入库内文件。
 * @param {object} opts
 * @param {'overwrite'|'create'|'append'} [opts.mode]
 * @returns {{path:string,bytes:number,changed:boolean,mode:string}}
 */
export function writeFile(root, rel, content, { mode = 'overwrite' } = {}) {
  if (typeof content !== 'string') throw new LibraryError('BAD_CONTENT', 'content 必须是字符串')
  const abs = resolveInside(root, rel)
  assertWritableTarget(abs)
  assertRealpathInside(root, abs)

  const exists = existsSync(abs)
  if (mode === 'create' && exists) {
    throw new LibraryError('FILE_EXISTS', `${rel} 已存在；要改它请用 overwrite 或 append`)
  }
  if (exists && statSync(abs).isDirectory()) {
    throw new LibraryError('TARGET_IS_DIR', `${rel} 是目录，不能当文件写`)
  }

  if (mode === 'append' && exists) {
    const prev = readFileSync(abs, 'utf8')
    const next = prev.endsWith('\n') || prev === '' ? `${prev}${content}` : `${prev}\n${content}`
    if (next === prev) return { path: rel, bytes: Buffer.byteLength(prev), changed: false, mode }
    writeAtomic(abs, next)
    return { path: rel, bytes: Buffer.byteLength(next), changed: true, mode }
  }

  if (exists) {
    const prev = readFileSync(abs, 'utf8')
    if (prev === content) return { path: rel, bytes: Buffer.byteLength(prev), changed: false, mode }
  }
  writeAtomic(abs, content)
  return { path: rel, bytes: Buffer.byteLength(content), changed: true, mode }
}

/** 原子写：同目录临时文件 + rename，失败清掉残骸（library_replace 也复用它）。 */
export function writeAtomic(abs, content) {
  const dir = dirname(abs)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, abs)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清不掉就算了 */
    }
    throw e
  }
}

/** 进程内互斥：两个并发 publish 会把索引写坏。 */
let publishing = false

/**
 * 跑 publish.sh，返回真实退出码与输出尾部。
 * 不抛错：失败也作为结构化结果返回，让模型自己判断要不要重试。
 */
export function runPublish(script, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (publishing) {
    throw new LibraryError('PUBLISH_IN_PROGRESS', '上一次 library_publish 还在跑，稍等它结束')
  }
  if (!existsSync(script)) {
    throw new LibraryError('PUBLISH_SCRIPT_MISSING', `publish 脚本不存在：${script}`)
  }
  publishing = true
  const started = Date.now()
  return new Promise((done) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      publishing = false
      done(result)
    }
    let child
    try {
      child = spawn('/bin/bash', [script, ...args], {
        cwd: dirname(script),
        env: { ...process.env, AGENTMEMORY_LIBRARY_PLUGIN: '1' },
      })
    } catch (e) {
      finish({ ok: false, code: 'PUBLISH_SPAWN_FAILED', message: String(e?.message ?? e) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
      finish({
        ok: false,
        code: 'PUBLISH_TIMEOUT',
        message: `publish.sh 超过 ${timeoutMs}ms 未结束，已 SIGKILL`,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: Date.now() - started,
        args,
      })
    }, timeoutMs)
    child.stdout?.on('data', (b) => {
      stdout += b.toString()
    })
    child.stderr?.on('data', (b) => {
      stderr += b.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, code: 'PUBLISH_SPAWN_FAILED', message: String(e?.message ?? e) })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      finish({
        ok: exitCode === 0,
        exitCode,
        signal,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: Date.now() - started,
        args,
      })
    })
  })
}
