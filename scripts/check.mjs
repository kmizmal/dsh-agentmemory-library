/**
 * 语法检查 + manifest 契约校验（照 dsh-bili-humanism 的 scripts/check.mjs）。
 * 这里不挂宿主，只做 `node --check` —— 插件源码 import 的 `@deepseek-ai/*` 在
 * profile 目录里解析不到（profile 的 node_modules 只有 cosmokit/schemastery），
 * 所以真正的加载验证交给 scripts/test-dsh-host.mjs。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = []
for (const dir of ['lib', 'scripts', 'test']) {
  for (const f of readdirSync(dir)) if (/\.(mjs|js)$/.test(f)) files.push(`${dir}/${f}`)
}
files.push('index.js')
files.push('client.js')

let failed = 0
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status) {
    console.error(`✗ ${file}\n${r.stderr}`)
    failed += 1
  }
}
if (failed) process.exit(1)

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const problems = []
if (!manifest.dsh?.bundle?.patch) problems.push('manifest 缺 dsh.bundle.patch')
else {
  const patch = readFileSync(manifest.dsh.bundle.patch, 'utf8')
  if (!patch.includes('insert:')) problems.push(`${manifest.dsh.bundle.patch} 里没有 insert:`)
  if (!patch.includes(manifest.name)) problems.push(`${manifest.dsh.bundle.patch} 里没写包名 ${manifest.name}`)
}
// 兼容性判定只看 engines.dsh（manifest 有它时 peerDependencies 全部忽略），所以必须有。
if (!manifest.engines?.dsh) problems.push('manifest 缺 engines.dsh —— 兼容性判定会退回 peerDependencies')
if (!manifest.engines?.node) problems.push('manifest 缺 engines.node')
if (!manifest.main) problems.push('manifest 缺 main')
if (manifest.type !== 'module') problems.push('manifest 必须 type: module')

if (problems.length) {
  console.error(`✗ manifest: ${problems.join('; ')}`)
  process.exit(1)
}
console.log(`Syntax checked ${files.length} source/test files; DSH manifest present.`)
