/**
 * 库根解析 + 越界防护。
 *
 * 这里的每个函数都是纯函数（除了会读一次配置文件），目的是能脱离 DSH 宿主单测。
 * 安全边界只有一条：**任何写入都必须落在库根之内**。读取同理——工具不该变成
 * 任意文件读取器。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** 默认库根：与 skill 的 scripts/search.mjs 完全同源，避免两套路径漂移。 */
export const DEFAULT_ROOT = '/root/copyparty/library/Obsidian/AgentMemory'

/** 索引生成物：写它们等于手改自动生成文件，一律拒绝。 */
export const GENERATED_FILES = new Set(['_index.json', '_索引.md'])

const CONFIG_PATH = join(homedir(), '.config', 'agentmemory-webdav.json')

export class LibraryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LibraryError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new LibraryError(code, message)
}

/**
 * 解析库根，优先级：显式参数 → AGENTMEMORY_ROOT → 配置文件 localRoot → DEFAULT_ROOT。
 * 配置读不到/坏掉不报错，直接下沉到下一级（与 search.mjs 的行为一致）。
 */
export function resolveLibraryRoot(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim())
  const env = process.env.AGENTMEMORY_ROOT
  if (typeof env === 'string' && env.trim()) return resolve(env.trim())
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (typeof cfg.localRoot === 'string' && cfg.localRoot.trim()) return resolve(cfg.localRoot.trim())
  } catch {
    /* 没有配置就走默认 */
  }
  return DEFAULT_ROOT
}

/**
 * 把调用方给的相对路径安全地拼到库根下。
 * 拒绝：空串、绝对路径、NUL、`..` 逃逸、拼接后仍在根外。
 * @returns {string} 绝对路径（未做符号链接解引用）
 */
export function resolveInside(root, rel) {
  const base = resolve(root)
  if (typeof rel !== 'string' || rel.trim() === '') fail('EMPTY_PATH', 'path 不能为空')
  if (rel.includes('\0')) fail('NUL_BYTE', 'path 不能包含 NUL 字节')
  if (isAbsolute(rel)) {
    fail('ABSOLUTE_PATH_NOT_ALLOWED', `只接受相对库根的路径，收到绝对路径：${rel}`)
  }
  const norm = normalize(rel)
  if (norm === '..' || norm.startsWith(`..${sep}`)) {
    fail('PATH_ESCAPES_LIBRARY', `路径越过库根：${rel}`)
  }
  const abs = resolve(base, norm)
  const back = abs.slice(base.length)
  if (abs !== base && !back.startsWith(sep)) {
    fail('PATH_ESCAPES_LIBRARY', `路径越过库根：${rel}`)
  }
  return abs
}

/** 生成物（`_index.json` / `_索引.md`）只能由 publish 重建，工具不得直写。 */
export function assertWritableTarget(abs) {
  const name = abs.slice(abs.lastIndexOf(sep) + 1)
  if (GENERATED_FILES.has(name)) {
    fail(
      'INDEX_FILE_WRITE_REFUSED',
      `${name} 是索引生成物，请改内容文件后调 library_publish 重建，别直接写它`,
    )
  }
}

/**
 * 写入前的真实路径校验：
 * 1. 目标已存在且是符号链接 → 拒绝（避免写穿到库外）
 * 2. 最近的已存在祖先目录的 realpath 必须仍在 realpath(root) 之内
 */
export function assertRealpathInside(root, abs) {
  const realRoot = realpathSync(resolve(root))
  if (existsSync(abs)) {
    // 必须用 lstat：statSync 会跟随符号链接，isSymbolicLink() 永远为 false。
    if (lstatSync(abs).isSymbolicLink()) {
      fail('SYMLINK_WRITE_REFUSED', `拒绝写入符号链接：${abs}（写入会被穿透到库外）`)
    }
  }
  let probe = abs
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..')
    if (parent === probe) break
    probe = parent
  }
  const realProbe = realpathSync(probe)
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    fail('PATH_ESCAPES_LIBRARY', `真实路径越过库根：${realProbe}（库根 ${realRoot}）`)
  }
  return realRoot
}
