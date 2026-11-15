/**
 * 宿主锚点集成测试：用**真** cordis + dsh-tools + dsh-app-boot 加载插件，
 * 断言注册、schema、执行、guard、dispose 全部成立。
 *
 * 为什么必须锚到宿主安装目录：profile 的 node_modules/@deepseek-ai/ 只有
 * cosmokit 与 schemastery，没有 dsh-tools —— 裸 node 直接 import 插件会
 * ERR_MODULE_NOT_FOUND。运行期 DSH 用 dsh-app-boot 的 HostResolvedRootInclude
 * 兜底到宿主 node_modules，这里用 registerHooks 复刻同一条解析路径。
 *
 * 不碰真库：DSH_TEST_TMP 下建一个临时库根，用插件配置 root 指过去。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'

const hostRoot = path.resolve(
  process.env.DSH_HOST_MODULE_ROOT || '/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules',
)
const hostURL = pathToFileURL(path.join(hostRoot, 'host-test.mjs')).href
const requireHost = createRequire(hostURL)
const load = (name) => import(pathToFileURL(requireHost.resolve(name)).href)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return nextResolve(specifier, { ...context, parentURL: hostURL })
    }
    return nextResolve(specifier, context)
  },
})

const pluginRoot = path.resolve(import.meta.dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-host-'))
const libraryRoot = path.join(work, 'library')
fs.mkdirSync(path.join(libraryRoot, '主题'), { recursive: true })
const doc = (fm, body) => `---\n${fm}\n---\n${body}`
fs.writeFileSync(
  path.join(libraryRoot, '00 总览.md'),
  doc('summary: 库首页\ndate: 2026-11-05', '# 总览\n\ncopyparty 是新的 WebDAV 真源'),
)
fs.writeFileSync(
  path.join(libraryRoot, '主题', 'copyparty.md'),
  doc(['summary: uv 装 copyparty', 'tags: [copyparty, webdav]'].join('\n'), '# copyparty 主题\n\ndav-inf 必须开'),
)
// 假的 publish.sh：验退出码传递与输出捕获，不跑真脚本（避免污染真库索引）
// 存在开关文件时以退出码 2 失败 —— 用来验「写库成功、收尾失败」不会把写库结果翻成 ok:false
const publishFailsWhen = path.join(work, 'publish-fail.flag')
const fakePublish = path.join(work, 'publish.sh')
fs.writeFileSync(
  fakePublish,
  [
    '#!/bin/bash',
    `if [ -f "${publishFailsWhen}" ]; then echo "index boom" >&2; exit 2; fi`,
    'echo "fake publish $*"',
    'echo "warn" >&2',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

const [{ Context, Service }, tools, boot, nativeExecutor] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-app-boot'),
  // 0.2.2 起 tools.execute() 必须有一个已加载的 executor，否则抛
  // ToolExecutorUnavailableError: The selected tool executor is unavailable.
  load('@deepseek-ai/dsh-tool-executor-native'),
])
const version = boot.getDshRuntimeVersion()

class Prompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }
  section(section) {
    sections.push(section)
    return () => {}
  }
  tools() {
    return () => {}
  }
  assemble() {
    return { sections: [], contexts: [], tools: [], variables: {} }
  }
}
const sections = []

const ctx = new Context()
let calls = 0
/**
 * 0.2.2 起 `tools.execute()` 收的是**批**输入 `{ calls: [{id,name,arguments}] }`，
 * 返回 `{ results: [{callId, result}] }`；单调用时代码用一个元素的批包一层。
 * （0.2.1 的 `{ name, arguments, callId }` 直接入参形态已不认，会抛
 * `TypeError: Cannot read properties of undefined (reading 'map')`。）
 */
const call = async (name, args = {}) => {
  const callId = `hosttest-${++calls}`
  const settlement = await ctx.tools.execute({
    calls: [{ id: callId, name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  })
  const entry = settlement.results.find((r) => r.callId === callId)
  assert.ok(entry, `批结果里没有 ${callId}：${JSON.stringify(settlement.results)}`)
  const result = entry.result
  const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = text
  }
  return { result, value, text }
}
const expectOk = async (name, args) => {
  const r = await call(name, args)
  assert.equal(r.result.isError, false, `${name} 失败：${r.text}`)
  assert.equal(r.value.ok, true, `${name} 返回 ok:false → ${r.text}`)
  return r.value
}
const expectFail = async (name, args, code) => {
  const r = await call(name, args)
  assert.equal(r.result.isError, false, '失败必须以结构化结果返回，不能让宿主抛错')
  assert.equal(r.value.ok, false, `期望失败却成功：${r.text}`)
  if (code) assert.equal(r.value.code, code, r.text)
  return r.value
}

let fiber
try {
  await ctx.plugin(Prompt).await()
  await ctx.plugin(tools.ToolRuntime).await()
  await ctx.plugin(nativeExecutor).await()

  const manifest = boot.readProfileManifest('compat', pluginRoot)
  assert.equal(manifest.name, 'dsh-agentmemory-library')
  assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, '本宿主版本应无需豁免即兼容')
  const entries = boot.composeEntries([
    boot.bundlePatchPaths(pluginRoot, manifest.dsh.bundle).flatMap((file) => boot.loadOverlayPatches('compat', file)),
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'dsh-agentmemory-library')

  const mod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['tools'])
  // ⚠️ 传**原始** config，不要先 `mod.Config(...)` 再喂给 ctx.plugin：
  //    解析后的 volatile 字段是 { get } 持有器，宿主会把它当原始值再校验一次
  //    （ValidationError: $.mode expected "local" | "cloud" but got {}）。
  //    持有器形态由 test/config.test.mjs 的 readConfig 用例单独覆盖。
  const config = { root: libraryRoot, publishScript: fakePublish, guidance: true }
  fiber = ctx.plugin(mod, config)
  await fiber.await()

  // ── 五个工具都在，且 schema 合法 ──
  const schemas = ctx.tools.schemas()
  const names = schemas.map((s) => s.name).sort()
  assert.deepEqual(names, [
    'library_list',
    'library_publish',
    'library_read',
    'library_replace',
    'library_search',
    'library_status',
    'library_write',
  ])
  for (const schema of schemas) tools.assertSupportedJsonSchema(schema.parameters)
  for (const schema of schemas) assert.ok(schema.description.length > 10, `${schema.name} 缺描述`)

  // ── 检索命中 ──
  const found = await expectOk('library_search', { query: 'copyparty' })
  assert.equal(found.total, 2)
  assert.ok(found.hits.some((h) => h.path === path.join('主题', 'copyparty.md')))

  const tagged = await expectOk('library_search', { query: 'copyparty', tag: 'webdav' })
  assert.equal(tagged.total, 1)

  const titled = await expectOk('library_search', { query: 'uv 装', titlesOnly: true })
  assert.equal(titled.total, 1)

  await expectFail('library_search', { query: '   ' }, 'EMPTY_QUERY')

  // ── 列表 ──
  const listed = await expectOk('library_list', { dir: '主题' })
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].kind, 'file')
  await expectFail('library_list', { dir: '不存在的目录' }, 'DIR_NOT_FOUND')

  // ── 读取 ──
  const read = await expectOk('library_read', { path: '00 总览.md' })
  assert.equal(read.frontmatter.summary, '库首页')
  assert.ok(read.content.includes('WebDAV 真源'))
  const ranged = await expectOk('library_read', { path: '00 总览.md', lines: '1-3' })
  assert.equal(ranged.from, 1)
  assert.equal(ranged.to, 3)
  await expectFail('library_read', { path: '没有这个文件.md' }, 'FILE_NOT_FOUND')
  await expectFail('library_read', { path: '../../etc/passwd' }, 'PATH_ESCAPES_LIBRARY')

  // ── 写入闭环：写 → 搜得到 → 索引生成物被拒 ──
  const written = await expectOk('library_write', {
    path: '主题/新增.md',
    content: doc('summary: 新增主题', '# 新增\n\n独特标记 qqqzzz'),
  })
  assert.equal(written.changed, true)
  assert.ok(written.hint.includes('library_publish'))
  assert.ok(!written.hint.includes('搜不到'), `提示不该再声称不 publish 就搜不到：${written.hint}`)
  assert.equal(written.publish, undefined, 'publish 默认不跑')
  const afterWrite = await expectOk('library_search', { query: 'qqqzzz' })
  assert.equal(afterWrite.total, 1)

  const untouched = await expectOk('library_write', {
    path: '主题/新增.md',
    content: doc('summary: 新增主题', '# 新增\n\n独特标记 qqqzzz'),
  })
  assert.equal(untouched.changed, false)

  await expectFail('library_write', { path: '_index.json', content: '{}' }, 'INDEX_FILE_WRITE_REFUSED')
  await expectFail('library_write', { path: '../逃逸.md', content: 'x' }, 'PATH_ESCAPES_LIBRARY')
  await expectFail('library_write', { path: '/tmp/逃逸.md', content: 'x' }, 'ABSOLUTE_PATH_NOT_ALLOWED')
  await expectFail('library_write', { path: 'x.md', content: 'x', mode: '瞎写' }, 'BAD_MODE')

  // 可选收尾：publish:true 时顺带跑一次，结果挂在 publish 字段上
  const writtenWithPublish = await expectOk('library_write', {
    path: '主题/顺带收尾.md',
    content: doc('summary: 顺带收尾', '# 收尾\n\n标记 sssvvv'),
    publish: true,
  })
  assert.equal(writtenWithPublish.publish.ok, true, JSON.stringify(writtenWithPublish.publish))
  assert.ok(writtenWithPublish.publish.stdoutTail.includes('fake publish'), writtenWithPublish.publish.stdoutTail)
  assert.ok(writtenWithPublish.hint.includes('publish 已跑完'), writtenWithPublish.hint)

  // 收尾失败绝不能把已落盘的写库翻成 ok:false（模型会据此重试、重复写一遍）
  fs.writeFileSync(publishFailsWhen, '1')
  const publishBroke = await expectOk('library_write', {
    path: '主题/收尾失败.md',
    content: doc('summary: 收尾失败也要写成功', '# 收尾失败\n\n标记 tttuuu'),
    publish: true,
  })
  assert.equal(publishBroke.changed, true)
  assert.equal(publishBroke.publish.ok, false)
  assert.equal(publishBroke.publish.exitCode, 2)
  assert.ok(publishBroke.hint.includes('publish 失败'), publishBroke.hint)
  assert.equal(fs.readFileSync(path.join(libraryRoot, '主题', '收尾失败.md'), 'utf8').includes('tttuuu'), true, '写库结果必须已经落盘')
  fs.rmSync(publishFailsWhen, { force: true })

  // ── 精准替换：唯一命中改一处 → 检索立刻看到；多义/找不到/生成物/越界全拒 ──
  const replaced = await expectOk('library_replace', {
    path: '主题/新增.md',
    oldString: '独特标记 qqqzzz',
    newString: '独特标记 rrrwww',
  })
  assert.equal(replaced.changed, true)
  assert.equal(replaced.occurrences, 1)
  assert.equal(replaced.matches[0].line, 6)
  assert.ok(replaced.hint.includes('library_publish'))
  const afterReplace = await expectOk('library_search', { query: 'rrrwww' })
  assert.equal(afterReplace.total, 1)
  const goneReplace = await expectOk('library_search', { query: 'qqqzzz' })
  assert.equal(goneReplace.total, 0)

  const bigDoc = ['---', 'summary: 大文件', '---', '# 大文件', '', '- 上游未修', '', '- 另一条', '', '- 上游未修', ''].join('\n')
  fs.writeFileSync(path.join(libraryRoot, '主题', '大.md'), bigDoc)
  const ambiguous = await expectFail('library_replace', { path: '主题/大.md', oldString: '上游未修', newString: 'x' }, 'AMBIGUOUS_MATCH')
  assert.ok(ambiguous.message.includes('6') && ambiguous.message.includes('10'), ambiguous.message)
  assert.equal(fs.readFileSync(path.join(libraryRoot, '主题', '大.md'), 'utf8'), bigDoc, '拒绝时不得改动文件')
  const allReplaced = await expectOk('library_replace', { path: '主题/大.md', oldString: '上游未修', newString: '已修', all: true })
  assert.equal(allReplaced.occurrences, 2)
  await expectFail('library_replace', { path: '主题/大.md', oldString: '不存在的句子', newString: 'x' }, 'STRING_NOT_FOUND')
  await expectFail('library_replace', { path: '_index.json', oldString: 'a', newString: 'b' }, 'INDEX_FILE_WRITE_REFUSED')
  await expectFail('library_replace', { path: '../逃逸.md', oldString: 'a', newString: 'b' }, 'PATH_ESCAPES_LIBRARY')
  await expectFail('library_replace', { path: '主题/大.md', oldString: '', newString: 'x' }, 'BAD_OLD_STRING')
  await expectFail('library_replace', { path: '没有这个.md', oldString: 'a', newString: 'b' }, 'FILE_NOT_FOUND')

  // 符号链接逃逸
  const outside = path.join(work, 'outside.md')
  fs.writeFileSync(outside, 'outside\n')
  fs.symlinkSync(outside, path.join(libraryRoot, '链接.md'))
  await expectFail('library_write', { path: '链接.md', content: 'x' }, 'SYMLINK_WRITE_REFUSED')
  await expectFail('library_replace', { path: '链接.md', oldString: 'outside', newString: 'x' }, 'SYMLINK_WRITE_REFUSED')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n', '符号链接指向的文件不得被改')

  // ── library_status：本地后端的状态卡（配置、生效库根、文件数、publish 能力）──
  const status = await expectOk('library_status', {})
  assert.equal(status.mode, 'local')
  assert.equal(status.root, libraryRoot)
  assert.equal(status.publish.supported, true)
  assert.equal(status.config.mode, 'local')
  assert.ok(status.markdownFiles >= 5, JSON.stringify(status))
  assert.equal(status.config.errors.length, 0)


  // ── publish 真的被 spawn 起来，退出码与输出都回传 ──
  const published = await expectOk('library_publish', {})
  assert.equal(published.exitCode, 0)
  assert.ok(published.stdoutTail.includes('fake publish'))
  assert.ok(published.stderrTail.includes('warn'))
  const checked = await expectOk('library_publish', { check: true, noVerify: true })
  assert.ok(checked.stdoutTail.includes('--check --no-verify'), checked.stdoutTail)

  // ── prompt section 注册 ──
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'agentmemory-library')
  assert.ok(Number.isFinite(sections[0].order))
  assert.ok(sections[0].text.includes('library_search'))
  assert.ok(sections[0].text.includes('library_status'), '后端是动态的，prompt 必须让模型去查 library_status')
  assert.equal(sections[0].text.includes('当前后端：'), false, '不能把一次性的后端快照写死进 prompt')

  // ── guard 能拒（这是唯一能按会话裁剪的机制）──
  const unguard = ctx.tools.guard((exec) => (exec.name.startsWith('library_') ? 'library tools denied for this session' : undefined))
  try {
    const settlement = await ctx.tools.execute({
      calls: [{ id: 'guarded-1', name: 'library_search', arguments: JSON.stringify({ query: 'copyparty' }) }],
      signal: new AbortController().signal,
    })
    const denied = settlement.results[0].result
    assert.equal(denied.isError, true)
    assert.match(denied.error.message, /library tools denied/)
  } finally {
    unguard()
  }

  // ── dispose 反注册 ──
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0, '卸载后不应残留工具')

  // ── 二次加载：云端模式缺配置 → 工具仍在，但调用返回结构化的 CONFIG_INVALID ──
  fiber = ctx.plugin(mod, { mode: 'cloud', publishScript: fakePublish, guidance: false })
  await fiber.await()
  const brokenStatus = await call('library_status', {})
  assert.equal(brokenStatus.value.ok, false)
  assert.equal(brokenStatus.value.code, 'CONFIG_INVALID')
  assert.equal(brokenStatus.result.isError, false)
  const brokenSearch = await expectFail('library_search', { query: 'copyparty' }, 'CONFIG_INVALID')
  assert.ok(brokenSearch.details.some((d) => d.field === 'cloud.url'), JSON.stringify(brokenSearch.details))
  assert.equal((await call('library_publish', {})).value.code, 'CONFIG_INVALID')
  await fiber.dispose()

  // ── 三次加载：库根不存在时工具仍注册，调用返回 LIBRARY_ROOT_MISSING ──
  const missing = path.join(work, 'does-not-exist')
  fiber = ctx.plugin(mod, { root: missing, publishScript: fakePublish, guidance: false })
  await fiber.await()
  assert.equal(ctx.tools.schemas().length, 7, '库缺失也要注册工具，让模型看到原因')
  const r = await call('library_search', { query: 'x' })
  assert.equal(r.result.isError, false)
  assert.equal(r.value.code, 'LIBRARY_ROOT_MISSING')
  await fiber.dispose()

  console.log(
    JSON.stringify({
      status: 'passed',
      host: version,
      tools: names,
      nativeCalls: calls,
      checks:
        'manifest/bundle 门禁、7 工具注册、参数 schema、执行、结构化失败、路径越界 6 类、符号链接、写入闭环、精准替换（唯一/多义/全替换/找不到/生成物/越界/符号链接）、library_status、云端缺配置降级、publish 退出码、prompt section、guard 拒绝、dispose 反注册、库缺失降级',
    }),
  )
} finally {
  await ctx.fiber.dispose()
  fs.rmSync(work, { recursive: true, force: true })
}
