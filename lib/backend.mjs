/**
 * 后端选择：`mode` 决定把读写发给谁，别的代码不再判断模式。
 *
 * 统一接口（两套实现必须同形）：
 *   describe()                    → 这条后端是谁（写进每条工具结果）
 *   ensureReady()                 → 不可用就抛契约错误
 *   search / list / read          → 读
 *   write / replace               → 写（本地=直接落盘；云端=先 PUT 再落镜像）
 *   status({probe})               → 给 library_status 与设置页
 *   publishSupported / publishNote
 *
 * 为什么后端要缓存：云端后端的镜像状态（lastSyncAt / remote 清单）必须跨调用
 * 保留，否则每次工具调用都会全量对账。缓存键由 `signatureOf()` 算，配置一变
 * 就换新后端 —— 所以「在设置页切换模式」下一次工具调用立刻生效，不用重启。
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryError } from './paths.mjs'
import { MODE_CLOUD } from './config.mjs'
import { allMarkdown, listDir, readFile as readLibraryFile, search as searchLibrary } from './search.mjs'
import { writeFile as writeLocalFile } from './publish.mjs'
import { replaceInFile } from './replace.mjs'
import { CloudBackend } from './cloud.mjs'

const rootState = (root) => {
  try {
    if (!existsSync(root)) return { ok: false, reason: 'missing' }
    if (!statSync(root).isDirectory()) return { ok: false, reason: 'not-a-directory' }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** 递归数文件（跳过隐藏文件），只用于状态展示。 */
const countFiles = (root) => {
  let total = 0
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs)
      else total += 1
    }
  }
  walk(root)
  return total
}

export class LocalBackend {
  constructor(effective) {
    this.mode = 'local'
    this.effective = effective
    this.root = effective.local.root
    this.warning = null
    this.publishSupported = true
    this.publishNote = ''
  }

  describe() {
    return { mode: 'local', root: this.root, rootSource: this.effective.local.source }
  }

  ensureReady() {
    const state = rootState(this.root)
    if (!state.ok) {
      throw new LibraryError(
        'LIBRARY_ROOT_MISSING',
        `资料库根不可用（${state.reason}）：${this.root}；把设置里的「本地库根目录」指到实际目录，` +
          '或用环境变量 AGENTMEMORY_ROOT 覆盖',
      )
    }
  }

  async search(query, options) {
    this.ensureReady()
    return searchLibrary(this.root, query, options)
  }

  async list(dir, options) {
    this.ensureReady()
    return { entries: listDir(this.root, dir, options) }
  }

  async read(frag, options) {
    this.ensureReady()
    return readLibraryFile(this.root, frag, options)
  }

  async write(rel, content, options) {
    this.ensureReady()
    const result = writeLocalFile(this.root, rel, content, options)
    return { ...result, backend: 'local' }
  }

  async replace(rel, options) {
    this.ensureReady()
    const result = replaceInFile(this.root, rel, options)
    return { ...result, backend: 'local' }
  }

  async status({ probe = false } = {}) {
    const state = rootState(this.root)
    const status = {
      mode: 'local',
      root: this.root,
      rootSource: this.effective.local.source,
      exists: state.ok,
      reason: state.ok ? undefined : state.reason,
      files: 0,
      markdownFiles: 0,
      writable: false,
      publish: { supported: true, script: this.effective.publish.script },
    }
    if (state.ok) {
      status.files = countFiles(this.root)
      status.markdownFiles = allMarkdown(this.root).length
      try {
        accessSync(this.root, constants.W_OK)
        status.writable = true
      } catch {
        status.writable = false
      }
      if (probe) status.probe = { ok: true, read: true, write: status.writable, latencyMs: 0 }
    } else if (probe) {
      status.probe = { ok: false, code: 'LIBRARY_ROOT_MISSING', message: `目录不可用：${this.root}` }
    }
    return status
  }
}

/** 按生效配置造后端。 */
export function createBackend(effective, { logger } = {}) {
  return effective.mode === MODE_CLOUD ? new CloudBackend(effective, { logger }) : new LocalBackend(effective)
}

/**
 * 后端缓存：同一份生效配置复用同一个实例。
 * 换模式 / 换 URL / 换账号 / 换密码 / 换镜像目录 / 换超时 —— 任何一项变了都重建。
 */
export class BackendPool {
  constructor({ logger } = {}) {
    this.logger = logger
    this.current = null
  }

  get(effective, signature) {
    if (this.current?.signature === signature) return this.current.backend
    this.current = { signature, backend: createBackend(effective, { logger: this.logger }) }
    return this.current.backend
  }

  /** 配置改了但还没到下一次工具调用时，设置页可以主动丢弃旧后端。 */
  reset() {
    this.current = null
  }
}