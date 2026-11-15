/**
 * 浏览器半端（client.js）的加载契约：
 *   · 用 `window.__ModuleLoader__.load({id,factory})` 自注册，id == 包名
 *   · factory 返回 `{inject:['slots','configForms'], apply}`
 *   · apply 会往 `settings.section` 槽注册一项 {id:'agentmemory-library', label:'资料库'}
 *
 * 不做真实渲染（需要整个 React DOM 运行时）；渲染层由重启后的 GUI 验收。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// jsdom 是测试期可选依赖（本机装在 /root/node_modules）；没有就跳过，不让整个套红。
let JSDOM = null
try {
  ;({ JSDOM } = await import('jsdom'))
} catch {
  JSDOM = null
}
const it = (name, fn) => (JSDOM ? test(name, fn) : test(name, { skip: '需要 jsdom' }, fn))

const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** jsdom 里建出来的对象/数组来自另一个 realm，原型不同 —— 先摊平成宿主对象再比。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

function loadBundle() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' })
  const registrations = []
  dom.window.__ModuleLoader__ = {
    load(spec) {
      registrations.push(spec)
    },
  }
  dom.window.eval(source)
  assert.equal(registrations.length, 1, 'client.js 必须只注册一次')
  return { dom, registration: registrations[0] }
}

const reactStub = {
  createElement: () => ({ type: 'div' }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: () => undefined,
}

it('自注册：id 等于包名，factory 返回 {inject, apply}', () => {
  const { registration } = loadBundle()
  assert.equal(registration.id, 'dsh-agentmemory-library')
  assert.equal(typeof registration.factory, 'function')
  const mod = registration.factory((name) => {
    assert.equal(name, 'react')
    return reactStub
  })
  assert.deepEqual(plain(mod.inject), ['slots', 'configForms'])
  assert.equal(typeof mod.apply, 'function')
})

it('apply：往 settings.section 注册「资料库」一页（order 35）', () => {
  const { dom, registration } = loadBundle()
  const mod = registration.factory(() => reactStub)
  const calls = { injected: [], specs: [], components: [] }
  const slots = {
    inject(name, callback) {
      calls.injected.push(name)
      calls.dispose = callback()
    },
    register(spec, component) {
      calls.specs.push(spec)
      calls.components.push(component)
      return () => {}
    },
  }
  const ctx = {
    slots,
    configForms: { get: () => null },
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  }
  mod.apply(ctx)
  assert.deepEqual(plain(calls.injected), ['settings.section'])
  assert.deepEqual(plain(calls.specs), [{ name: 'settings.section', id: 'agentmemory-library', order: 35, label: '资料库' }])
  assert.equal(typeof calls.components[0], 'function')
  // 样式只注入一次，且带插件标记（卸载时能摘掉）
  const styles = dom.window.document.head.querySelectorAll('style[data-plugin-css="dsh-agentmemory-library"]')
  assert.equal(styles.length, 1)
})

it('apply：没有 slots 服务时安静退出，不抛错', () => {
  const { registration } = loadBundle()
  const mod = registration.factory(() => reactStub)
  const ctx = { configForms: { get: () => null }, get: () => undefined }
  assert.doesNotThrow(() => mod.apply(ctx))
})

it('apply：slots.register 抛错也不影响插件加载（设置页降级，原生表单仍在）', () => {
  const { registration } = loadBundle()
  const mod = registration.factory(() => reactStub)
  const ctx = {
    configForms: { get: () => null },
    get: () => ({
      inject: (_name, callback) => {
        callback()
      },
      register: () => {
        throw new Error('slot closed')
      },
    }),
  }
  assert.doesNotThrow(() => mod.apply(ctx))
})