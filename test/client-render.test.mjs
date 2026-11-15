/**
 * 设置页面板的**真实渲染**测试（jsdom + React 19）。
 *
 * 为什么值得：设置页是这次改造的主要交付面，而它只有重启宿主后才会出现在 GUI 里。
 * 这里用假 `configForms` + 假 `fetch` 把「模式切换 → 条件字段 → 校验 → 保存 →
 * 测试连接 → 状态卡」整条交互跑一遍，避免"面板写错但没人发现"。
 *
 * 依赖是**可选**的（test/vendor/react-runtime 下 npm 装的 react/react-dom + 本机 jsdom），
 * 缺了就跳过，不让整套测试变红。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

const here = import.meta.dirname
const vendorPkg = join(here, 'vendor', 'react-runtime', 'package.json')

let JSDOM = null
let React = null
let createRoot = null
let act = null
let sharedDom = null

try {
  ;({ JSDOM } = await import('jsdom'))
  if (JSDOM && existsSync(vendorPkg)) {
    // react-dom 在 import 时就会探测 window/document（canUseDOM），所以必须在
    // require 之前把 jsdom 挂到全局，并且整个文件共用同一个 window。
    sharedDom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://127.0.0.1:3080/',
    })
    globalThis.window = sharedDom.window
    globalThis.document = sharedDom.window.document
    try {
      Object.defineProperty(globalThis, 'navigator', { value: sharedDom.window.navigator, configurable: true })
    } catch {
      /* Node 自带 navigator，改不动就算了 */
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const requireVendor = createRequire(vendorPkg)
    React = requireVendor('react')
    ;({ createRoot } = requireVendor('react-dom/client'))
    act = React.act
  }
} catch {
  React = null
}
const enabled = Boolean(JSDOM && React && createRoot && act && sharedDom)
const it = (name, fn) => (enabled ? test(name, fn) : test(name, { skip: '需要 jsdom + test/vendor/react-runtime' }, fn))

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

function setup({ status = null, testResult = null } = {}) {
  const dom = sharedDom
  const win = dom.window
  win.document.body.innerHTML = '<div id="root"></div>'
  const calls = { fetch: [], mutate: [] }

  win.__ModuleLoader__ = { load: (spec) => (calls.registration = spec) }
  win.fetch = async (url, init) => {
    const path = String(url)
    calls.fetch.push({ path, init })
    let body = { ok: true }
    if (path.startsWith('/api/agentmemory-library/status')) {
      body = status ?? {
        ok: true,
        mode: 'local',
        config: { mode: 'local', local: { configured: '/tmp/lib', effectiveRoot: '/tmp/lib', source: 'local.root' }, cloud: { passwordSet: false } },
        status: { mode: 'local', root: '/tmp/lib', files: 3, markdownFiles: 3, publish: { supported: true } },
      }
    } else if (path.startsWith('/api/agentmemory-library/test')) {
      body = testResult ?? { ok: true, mode: 'cloud', read: true, write: true, latencyMs: 12 }
    } else if (path.startsWith('/api/agentmemory-library/legacy')) {
      body = { ok: true, found: false, message: '没有找到旧配置' }
    } else if (path.startsWith('/api/agentmemory-library/refresh')) {
      body = { ok: true, mode: 'local', message: '本地模式无需刷新（读的就是磁盘）' }
    }
    return { ok: true, status: 200, json: async () => body }
  }

  win.eval(source)
  assert.ok(calls.registration, 'client.js 没有自注册')

  const mod = calls.registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  // 可控的 configForms 替身：state 由测试改，mutate 记录 ops 并更新 state
  const formState = {
    status: 'ready',
    value: { mode: 'local', local: { root: '/tmp/lib' }, cloud: {} },
    revision: 1,
    writable: true,
    base: undefined,
    user: undefined,
  }
  const listeners = new Set()
  const form = {
    getSnapshot: () => formState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, revision) => {
      calls.mutate.push({ ops, revision })
      // 模拟宿主：把 set 操作写进 value，revision +1，通知订阅者
      const next = JSON.parse(JSON.stringify(formState.value))
      for (const op of ops) {
        if (op.op !== 'set') continue
        let node = next
        for (const key of op.path.slice(0, -1)) node = node[key] ??= {}
        node[op.path[op.path.length - 1]] = op.value
      }
      formState.value = next
      formState.revision += 1
      for (const listener of listeners) listener()
      return true
    },
  }

  const slots = {
    injected: [],
    specs: [],
    components: [],
    inject(name, callback) {
      this.injected.push(name)
      this.dispose = callback()
    },
    register(spec, component) {
      this.specs.push(spec)
      this.components.push(component)
      return () => {}
    },
  }
  const ctx = {
    slots,
    configForms: { get: (ns) => (ns === 'agentmemory-library' ? form : null) },
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  }
  mod.apply(ctx)
  const notify = () => {
    formState.revision += 1
    for (const listener of listeners) listener()
  }
  return { dom, win, ctx, slots, calls, formState, form, mod, notify }
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const click = async (win, element) => {
  await act(async () => {
    element.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const type = async (win, input, value) => {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
  await flush()
}

const byText = (win, selector, text) =>
  [...win.document.querySelectorAll(selector)].find((node) => node.textContent.trim() === text)

/** 保存按钮 / 未保存提示 —— 需求 2、3 的两个观测点。 */
const saveButton = (win) => byText(win, '[data-aml-btn]', '保存设置')
const isDirty = (win) => Boolean(win.document.querySelector('[data-aml-dirty]'))
const dirtyText = (win) => (win.document.querySelector('[data-aml-dirty]') || {}).textContent || ''

it('默认本地模式：只显示库根目录，状态卡出现生效路径', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const text = win.document.body.textContent
  assert.match(text, /资料库 · 存储模式/)
  assert.match(text, /库根目录/)
  assert.equal(text.includes('WebDAV 地址'), false)
  assert.match(text, /当前状态 · 本地目录/)
  assert.match(text, /\/tmp\/lib/)
  await act(async () => root.unmount())
})

it('切到云端：出现 WebDAV 三项，库根目录消失；空字段保存 → 字段级错误', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()

  await click(win, byText(win, '[data-aml-seg] button', '云端模式（WebDAV）'))
  const text = win.document.body.textContent
  assert.match(text, /WebDAV 地址/)
  assert.match(text, /账号/)
  assert.match(text, /密码 \/ 应用密码/)
  assert.equal(text.includes('库根目录'), false)

  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  const errText = win.document.body.textContent
  assert.match(errText, /云端模式必须填写 WebDAV 地址/)
  assert.match(errText, /云端模式必须填写账号/)
  assert.match(errText, /云端模式必须填写密码/)
  assert.match(errText, /还有必填项没填对/)
  assert.equal(calls.mutate.length, 0, '校验没过就不能写配置')

  await act(async () => root.unmount())
})

it('填好云端字段保存：提交 mode/url/username/password，并给出成功提示', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  await click(win, byText(win, '[data-aml-seg] button', '云端模式（WebDAV）'))

  const inputs = [...win.document.querySelectorAll('[data-aml-field] input')]
  const urlInput = inputs.find((node) => node.getAttribute('placeholder')?.includes('dav.example.com'))
  const textInputs = inputs.filter((node) => node.getAttribute('type') !== 'password')
  const usernameInput = textInputs.find((node) => node !== urlInput)
  const passwordInput = inputs.find((node) => node.getAttribute('type') === 'password')
  assert.ok(urlInput && usernameInput && passwordInput, '缺少输入框')

  await type(win, urlInput, 'https://dav.example.com/lib/')
  await type(win, usernameInput, 'zmal')
  await type(win, passwordInput, 'app-password')

  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  assert.equal(calls.mutate.length, 1, '应该提交一次')
  const ops = calls.mutate[0].ops
  const byPath = Object.fromEntries(ops.map((op) => [op.path.join('.'), op.value]))
  assert.equal(byPath.mode, 'cloud')
  assert.equal(byPath['cloud.url'], 'https://dav.example.com/lib/')
  assert.equal(byPath['cloud.username'], 'zmal')
  assert.equal(byPath['cloud.password'], 'app-password')
  assert.match(win.document.body.textContent, /已保存，后端已切换到「云端（WebDAV）」模式/)

  await act(async () => root.unmount())
})

it('测试连接：把草稿值发给 /test，展示延迟；失败时展示 code', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const ok = setup({ testResult: { ok: true, mode: 'cloud', read: true, write: true, latencyMs: 12 } })
  const root = createRoot(ok.win.document.getElementById('root'))
  await act(async () => {
    root.render(ok.slots.components[0]())
  })
  await flush()
  await click(ok.win, byText(ok.win, '[data-aml-btn]', '测试连接'))
  assert.match(ok.win.document.body.textContent, /连接成功：读取 ✓/)
  assert.match(ok.win.document.body.textContent, /12ms/)
  const testCall = ok.calls.fetch.find((call) => call.path.startsWith('/api/agentmemory-library/test'))
  assert.equal(JSON.parse(testCall.init.body).mode, 'local')
  await act(async () => root.unmount())

  const bad = setup({ testResult: { ok: false, code: 'CLOUD_AUTH_FAILED', message: 'WebDAV 认证失败（401）' } })
  const root2 = createRoot(bad.win.document.getElementById('root'))
  await act(async () => {
    root2.render(bad.slots.components[0]())
  })
  await flush()
  await click(bad.win, byText(bad.win, '[data-aml-btn]', '测试连接'))
  assert.match(bad.win.document.body.textContent, /CLOUD_AUTH_FAILED/)
  await act(async () => root2.unmount())
})

it('本地模式改库根再保存：只提交 local.root 一项', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/another-lib')
  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  assert.equal(calls.mutate.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.mutate[0].ops)), [{ op: 'set', path: ['local', 'root'], value: '/tmp/another-lib' }])
  await act(async () => root.unmount())
})

it('宿主拒绝写入：给出失败提示（不假装成功）', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls, form } = setup()
  form.mutate = async (ops) => {
    calls.mutate.push({ ops })
    return false
  }
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/another-lib')
  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  assert.match(win.document.body.textContent, /保存失败：宿主拒绝了这次写入/)
  await act(async () => root.unmount())
})

it('本地库根留空是合法的（走环境变量/旧配置/默认）；未改动时保存按钮禁用', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, formState, calls } = setup()
  formState.value = { mode: 'local', local: { root: '' }, cloud: {} }
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const text = win.document.body.textContent
  assert.equal(text.includes('必须填写库根目录'), false)
  assert.equal(saveButton(win).disabled, true)
  assert.equal(isDirty(win), false)
  assert.equal(calls.mutate.length, 0)
  await act(async () => root.unmount())
})

it('只有兼容字段 root 时：输入框显示它，并提示来自兼容字段', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, formState } = setup()
  formState.value = { mode: 'local', root: '/legacy/lib', local: { root: '' }, cloud: {} }
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  assert.equal(input.value, '/legacy/lib')
  assert.match(win.document.body.textContent, /来自兼容字段 root/)
  await act(async () => root.unmount())
})

it('改动检测：初始禁用无提示；改一项立即启用并提示；还原后重新禁用、提示消失', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()

  assert.equal(saveButton(win).disabled, true, '未改动时保存必须禁用')
  assert.equal(isDirty(win), false)

  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/changed-lib')
  assert.equal(saveButton(win).disabled, false, '有改动后保存必须可点')
  assert.equal(isDirty(win), true)
  assert.match(dirtyText(win), /未保存的改动/)

  // 还原成初始值 → 按钮重新禁用、提示消失
  await type(win, input, '/tmp/lib')
  assert.equal(saveButton(win).disabled, true)
  assert.equal(isDirty(win), false)
  assert.equal(calls.mutate.length, 0)
  await act(async () => root.unmount())
})

it('改动检测：模式切换算改动，切回去就不算', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  assert.equal(saveButton(win).disabled, true)

  await click(win, byText(win, '[data-aml-seg] button', '云端模式（WebDAV）'))
  assert.equal(saveButton(win).disabled, false)
  assert.equal(isDirty(win), true)

  await click(win, byText(win, '[data-aml-seg] button', '本地模式'))
  assert.equal(saveButton(win).disabled, true)
  assert.equal(isDirty(win), false)
  await act(async () => root.unmount())
})

it('改动检测：云端模式每个输入框 / 复选框都能触发，还原即恢复禁用', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, formState, notify } = setup()
  formState.value = {
    mode: 'cloud',
    local: { root: '/tmp/lib' },
    cloud: { url: 'https://dav.example.com/lib/', username: 'u', refreshTtlMs: 60000, timeoutMs: 20000, retries: 2 },
  }
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  assert.equal(isDirty(win), false, '打开时不应算改动')
  assert.equal(saveButton(win).disabled, true)

  const inputs = [...win.document.querySelectorAll('[data-aml-field] input')]
  assert.ok(inputs.length >= 7, '应该有 url/账号/密码/镜像/ttl/timeout/retries 七个输入')
  for (const input of inputs) {
    const original = input.value
    await type(win, input, original === '' ? 'x' : `${original}x`)
    assert.equal(saveButton(win).disabled, false, `改 ${input.type} 后保存应可点`)
    assert.equal(isDirty(win), true)
    await type(win, input, original)
    assert.equal(saveButton(win).disabled, true, `还原 ${input.type} 后保存应禁用`)
    assert.equal(isDirty(win), false)
  }

  const tls = [...win.document.querySelectorAll('input[type=checkbox]')].find((node) =>
    node.parentElement.textContent.includes('跳过 TLS'),
  )
  assert.ok(tls, '应该有 TLS 复选框')
  await click(win, tls)
  assert.equal(isDirty(win), true)
  await click(win, tls)
  assert.equal(isDirty(win), false)
  assert.equal(saveButton(win).disabled, true)

  // 数字框里输入非法值也算改动（否则用户看不到校验提示）
  const ttl = inputs.find((node) => node.type === 'number')
  await type(win, ttl, 'abc')
  assert.equal(isDirty(win), true)
  await type(win, ttl, '60000')
  assert.equal(isDirty(win), false)
  await act(async () => root.unmount())
})

it('撤销按钮：恢复基线、按钮禁用、提示消失', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/changed')
  assert.equal(isDirty(win), true)

  await click(win, byText(win, '[data-aml-btn]', '撤销改动'))
  assert.equal(isDirty(win), false)
  assert.equal(saveButton(win).disabled, true)
  assert.equal(input.value, '/tmp/lib', '输入框要回到基线值')
  assert.match(win.document.body.textContent, /已撤销未保存的改动/)
  assert.equal(calls.mutate.length, 0)
  await act(async () => root.unmount())
})

it('保存成功：提示消失、按钮变禁用、基线前移到新值', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls, formState } = setup()
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/new-baseline')
  assert.equal(isDirty(win), true)
  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  assert.equal(calls.mutate.length, 1)
  assert.equal(formState.value.local.root, '/tmp/new-baseline')
  assert.equal(isDirty(win), false, '保存成功后提示必须消失')
  assert.equal(saveButton(win).disabled, true, '保存成功后按钮必须回到禁用')
  await act(async () => root.unmount())
})

it('保存失败：按钮保持启用、提示保留、草稿不丢', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { win, slots, calls, form } = setup()
  form.mutate = async (ops) => {
    calls.mutate.push({ ops })
    return false
  }
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(slots.components[0]())
  })
  await flush()
  const input = win.document.querySelector('[data-aml-field] input')
  await type(win, input, '/tmp/will-fail')
  await click(win, byText(win, '[data-aml-btn]', '保存设置'))
  assert.match(win.document.body.textContent, /保存失败：宿主拒绝了这次写入/)
  assert.equal(isDirty(win), true, '失败后未保存提示必须还在')
  assert.equal(saveButton(win).disabled, false, '失败后保存按钮必须还能再点')
  assert.equal(input.value, '/tmp/will-fail', '草稿不能丢')
  await act(async () => root.unmount())
})
