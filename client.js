/**
 * dsh-agentmemory-library —— 浏览器半端（「设置 → 资料库」这一页）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（与 dsh-bili-scroll / dsh-web-search 同一约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                     // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: [...], apply(ctx) {...} }),
 *     })
 *
 * 这一页要做的事（对应需求里的设置页部分）：
 *   · 模式切换控件：本地模式 / 云端模式（WebDAV）
 *   · 选本地 → 只显示「库根目录」；选云端 → 显示 WebDAV 地址 / 账号 / 密码（+ 高级项）
 *   · 必填校验（前端校验 + 宿主侧二次校验，错误定位到具体字段）
 *   · 保存成功/失败提示（toast）+「测试连接」按钮（保存前就能试）
 *   · 状态卡：当前生效库根/镜像、文件数、上次同步、密码是否已保存
 *
 * 配置的读写走宿主自己的 `configForms`：它负责 revision 冲突检测、写进 profile 补丁、
 * 并且**不会把 `role('secret')` 字段回显给浏览器**（所以密码框永远是空的，
 * 是否已保存由 /api/agentmemory-library/status 回答）。
 * ============================================================================
 */
;(function () {
  'use strict'
  if (typeof window === 'undefined') return
  var loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  loader.load({
    id: 'dsh-agentmemory-library',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      /** 宿主 loader 条目的 id，也是设置命名空间。 */
      var NS = 'agentmemory-library'
      var API = '/api/agentmemory-library'
      var SLOT = 'settings.section'

      var useSync =
        typeof React.useSyncExternalStore === 'function'
          ? React.useSyncExternalStore
          : function (subscribe, getSnapshot) {
              var pair = React.useState(getSnapshot)
              React.useEffect(function () {
                return subscribe(function () {
                  pair[1](getSnapshot())
                })
              }, [subscribe, getSnapshot])
              return pair[0]
            }

      var EMPTY = Object.freeze({ status: 'loading', value: undefined, revision: undefined, writable: false })

      var CSS = [
        '[data-aml-panel]{display:flex;flex-direction:column;gap:14px;max-width:720px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6)}',
        '[data-aml-panel] h3{margin:0;font-size:16px;line-height:1.4}',
        '[data-aml-panel] p.desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
        '[data-aml-card]{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}',
        '[data-aml-seg]{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:8px;overflow:hidden;align-self:flex-start}',
        '[data-aml-seg] button{border:0;background:transparent;color:inherit;padding:6px 14px;font-size:12.5px;cursor:pointer}',
        '[data-aml-seg] button[data-on="1"]{background:var(--dsw-alias-bg-accent,rgba(90,140,255,.22));font-weight:600}',
        '[data-aml-field]{display:flex;flex-direction:column;gap:4px}',
        '[data-aml-field] label{font-size:12px;color:var(--dsw-alias-label-secondary,#c2c7cf)}',
        '[data-aml-field] input[type=text],[data-aml-field] input[type=password],[data-aml-field] input[type=number]{background:var(--dsw-alias-bg-base,#1b1c1f);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:6px;color:inherit;padding:6px 8px;font-size:12.5px;font-family:inherit}',
        '[data-aml-field] input:focus{outline:1px solid var(--dsw-alias-brand-primary,#6f9bff);outline-offset:0}',
        '[data-aml-field] small{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8b9099)}',
        '[data-aml-field] small[data-err="1"]{color:var(--dsw-alias-state-warn-primary,#ff8a80)}',
        '[data-aml-row]{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
        '[data-aml-btn]{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));background:var(--dsw-alias-bg-base,#1b1c1f);color:inherit;font-size:12px;cursor:pointer}',
        '[data-aml-btn][data-primary="1"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d7cff);color:#fff}',
        '[data-aml-btn]:disabled{opacity:.5;cursor:not-allowed}',
        '[data-aml-note]{font-size:12px;line-height:1.6;padding:7px 9px;border-radius:7px;border:1px solid transparent}',
        '[data-aml-note="ok"]{color:var(--dsw-alias-state-success-primary,#5bd18b);background:rgba(91,209,139,.08);border-color:rgba(91,209,139,.28)}',
        '[data-aml-note="bad"]{color:var(--dsw-alias-state-warn-primary,#ff8a80);background:rgba(255,138,128,.08);border-color:rgba(255,138,128,.28)}',
        '[data-aml-note="info"]{color:var(--dsw-alias-label-secondary,#c2c7cf);background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1)}',
        '[data-aml-note="warn"]{color:var(--dsw-alias-state-warn-primary,#ffcc66);background:rgba(255,204,102,.09);border-color:rgba(255,204,102,.32)}',
        '[data-aml-dirty]{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600}',
        '[data-aml-dirty]::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto}',
        '[data-aml-kv]{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;font-size:12px}',
        '[data-aml-kv] span:nth-child(odd){color:var(--dsw-alias-label-tertiary,#8b9099)}',
        '[data-aml-kv] span{word-break:break-all}',
        '[data-aml-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}',
        '[data-aml-adv]{border-top:1px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.12));padding-top:8px;display:flex;flex-direction:column;gap:10px}',
        '[data-aml-adv] summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#c2c7cf)}',
      ].join('\n')

      // ── HTTP helpers ───────────────────────────────────────────────────────
      function jget(path) {
        return fetch(API + path, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (res) {
          return res.json().then(
            function (body) {
              return body
            },
            function () {
              return { ok: false, code: 'BAD_JSON', message: 'HTTP ' + res.status }
            },
          )
        })
      }
      function jpost(path, body) {
        return fetch(API + path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(function (res) {
          return res.json().then(
            function (data) {
              return data
            },
            function () {
              return { ok: false, code: 'BAD_JSON', message: 'HTTP ' + res.status }
            },
          )
        })
      }

      // ── 小工具 ─────────────────────────────────────────────────────────────
      function isAbsolutePath(value) {
        return typeof value === 'string' && (value.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(value))
      }
      function trimmed(value) {
        return String(value === undefined || value === null ? '' : value).trim()
      }
      function intOr(value, fallback) {
        var text = trimmed(value)
        if (text === '') return fallback
        var n = Number(text)
        return isFinite(n) ? Math.round(n) : fallback
      }
      function fmtTime(ms) {
        if (!ms) return '从未'
        try {
          return new Date(ms).toLocaleString()
        } catch (e) {
          return String(ms)
        }
      }

      /**
       * 配置页里**所有可编辑控件**（改动检测的范围）。新增控件时必须同时登记在这里，
       * 否则会出现"改了但保存按钮还是灰的"。
       * key 与 Panel 内 current() 的分支一一对应。
       */
      var EDITABLE_FIELDS = [
        { key: 'mode' }, // 分段控件（本地 / 云端）
        { key: 'localRoot' }, // 文本输入
        { key: 'url' }, // 文本输入
        { key: 'username' }, // 文本输入
        { key: 'password' }, // 密码输入（基线永远是空串：只写不回显）
        { key: 'cacheDir' }, // 文本输入
        { key: 'ttl' }, // 数字输入
        { key: 'timeout' }, // 数字输入
        { key: 'retries' }, // 数字输入
        { key: 'insecureTls', boolean: true }, // 复选框
      ]

      // ── 面板 ───────────────────────────────────────────────────────────────
      function Panel() {
        var ctx = Panel.ctx
        var form = ctx && ctx.configForms && typeof ctx.configForms.get === 'function' ? ctx.configForms.get(NS) : null
        if (!form && ctx && ctx.configForms && typeof ctx.configForms.get === 'function') form = ctx.configForms.get('include:' + NS)

        var subscribe = React.useCallback(
          function (listener) {
            return form && typeof form.subscribe === 'function' ? form.subscribe(listener) : function () {}
          },
          [form],
        )
        var getSnapshot = React.useCallback(function () {
          return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : EMPTY
        }, [form])
        var state = useSync(subscribe, getSnapshot)

        var draftPair = React.useState(null)
        var draft = draftPair[0]
        var setDraft = draftPair[1]
        var errPair = React.useState({})
        var errors = errPair[0]
        var setErrors = errPair[1]
        var phasePair = React.useState('idle') // idle | saving | saved | failed
        var phase = phasePair[0]
        var setPhase = phasePair[1]
        var toastPair = React.useState(null) // {kind:'ok'|'bad'|'info', text}
        var toast = toastPair[0]
        var setToast = toastPair[1]
        var statusPair = React.useState(null)
        var status = statusPair[0]
        var setStatus = statusPair[1]
        var testPair = React.useState(null) // {phase, text, kind}
        var test = testPair[0]
        var setTest = testPair[1]
        var advPair = React.useState(false)
        var advanced = advPair[0]
        var setAdvanced = advPair[1]
        var writeTestPair = React.useState(false)
        var writeTest = writeTestPair[0]
        var setWriteTest = writeTestPair[1]

        var refreshStatus = React.useCallback(
          function () {
            jget('/status')
              .then(function (data) {
                setStatus(data)
              })
              .catch(function (error) {
                setStatus({ ok: false, code: 'STATUS_FAILED', message: String(error) })
              })
          },
          [],
        )

        React.useEffect(function () {
          refreshStatus()
        }, [refreshStatus])

        // 第一次进云端模式且镜像还没建过：自动拉一次，免得状态卡一直显示 0 个文件
        var bootstrapped = React.useRef(false)
        React.useEffect(function () {
          if (bootstrapped.current || !status || status.ok !== true) return
          var s = status.status || {}
          if (s.mode === 'cloud' && !s.lastSyncAt) {
            bootstrapped.current = true
            jpost('/refresh', {})
              .then(function () {
                refreshStatus()
              })
              .catch(function () {})
          }
        }, [status, refreshStatus])

        // 保存成功（revision 变了）后清草稿与错误
        React.useEffect(
          function () {
            setDraft(null)
            setErrors({})
          },
          [state.revision],
        )

        var ready = state && state.status === 'ready'
        var values = (ready && state.value) || {}
        var cloudValue = values.cloud || {}
        var localValue = values.local || {}
        var passwordSet = Boolean(status && status.ok && status.config && status.config.cloud && status.config.cloud.passwordSet)

        function current(key) {
          if (draft && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
          switch (key) {
            case 'mode':
              return values.mode || 'local'
            case 'localRoot':
              // 兼容字段 root 也要显示出来；留空表示走环境变量/旧配置/默认路径
              return localValue.root || values.root || ''
            case 'url':
              return cloudValue.url || ''
            case 'username':
              return cloudValue.username || ''
            case 'password':
              return ''
            case 'cacheDir':
              return cloudValue.cacheDir || ''
            case 'ttl':
              return cloudValue.refreshTtlMs === undefined ? 60000 : cloudValue.refreshTtlMs
            case 'timeout':
              return cloudValue.timeoutMs === undefined ? 20000 : cloudValue.timeoutMs
            case 'retries':
              return cloudValue.retries === undefined ? 2 : cloudValue.retries
            case 'insecureTls':
              return cloudValue.insecureTls === true
            default:
              return ''
          }
        }

        function edit(key, value) {
          var next = {}
          var base = draft || {}
          for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k]
          next[key] = value
          setDraft(next)
          if (phase !== 'idle') setPhase('idle')
          if (errors[key]) {
            var cleared = {}
            for (var e in errors) if (Object.prototype.hasOwnProperty.call(errors, e) && e !== key) cleared[e] = errors[e]
            setErrors(cleared)
          }
        }

        /** 前端校验：与宿主侧同一套规则（宿主那份才是权威，这里只为即时反馈）。 */
        function validate() {
          var found = {}
          var mode = current('mode')
          if (mode === 'cloud') {
            var url = trimmed(current('url'))
            if (!url) found.url = '云端模式必须填写 WebDAV 地址'
            else if (!/^https?:\/\//i.test(url)) found.url = '地址必须以 http:// 或 https:// 开头'
            if (!trimmed(current('username'))) found.username = '云端模式必须填写账号'
            if (!current('password') && !passwordSet) found.password = '云端模式必须填写密码'
            var cacheDir = trimmed(current('cacheDir'))
            if (cacheDir && !isAbsolutePath(cacheDir)) found.cacheDir = '镜像目录必须是绝对路径'
            var ttl = intOr(current('ttl'), -1)
            if (ttl < 0 || ttl > 3600000) found.ttl = '刷新间隔需在 0–3600000 毫秒之间'
            var timeout = intOr(current('timeout'), -1)
            if (timeout < 1000 || timeout > 600000) found.timeout = '超时需在 1000–600000 毫秒之间'
            var retries = intOr(current('retries'), -1)
            if (retries < 0 || retries > 5) found.retries = '重试次数需在 0–5 之间'
          } else {
            // 留空是合法的：宿主会按 AGENTMEMORY_ROOT → 旧配置 localRoot → 默认路径解析。
            // 这里只校验"填了就必须是绝对路径"，与 lib/config.mjs 的规则保持一致。
            var root = trimmed(current('localRoot'))
            if (root && !isAbsolutePath(root)) found.localRoot = '库根目录必须是绝对路径（以 / 开头）'
          }
          return found
        }

        /** 只把真正改过的字段发给宿主（数组/对象形式的 patch 宿主会做深合并）。 */
        function operations() {
          var ops = []
          var mode = current('mode')
          if (mode !== (values.mode || 'local')) ops.push({ op: 'set', path: ['mode'], value: mode })
          var root = trimmed(current('localRoot'))
          var rootBaseline = trimmed(localValue.root || values.root)
          if (root !== rootBaseline) {
            // 面板里显示的是兼容字段 root、而 local.root 还是空的时候，清空它只能
            // 用 unset 取消兼容字段，否则保存后基线又回到旧值、按钮永远灰不下去。
            if (root === '' && !trimmed(localValue.root) && trimmed(values.root)) {
              ops.push({ op: 'unset', path: ['root'] })
            } else {
              ops.push({ op: 'set', path: ['local', 'root'], value: root })
            }
          }
          var url = trimmed(current('url'))
          if (url !== trimmed(cloudValue.url)) ops.push({ op: 'set', path: ['cloud', 'url'], value: url })
          var username = trimmed(current('username'))
          if (username !== trimmed(cloudValue.username)) ops.push({ op: 'set', path: ['cloud', 'username'], value: username })
          if (current('password')) ops.push({ op: 'set', path: ['cloud', 'password'], value: current('password') })
          var cacheDir = trimmed(current('cacheDir'))
          if (cacheDir !== trimmed(cloudValue.cacheDir)) ops.push({ op: 'set', path: ['cloud', 'cacheDir'], value: cacheDir })
          var ttl = intOr(current('ttl'), 60000)
          if (ttl !== intOr(cloudValue.refreshTtlMs, 60000)) ops.push({ op: 'set', path: ['cloud', 'refreshTtlMs'], value: ttl })
          var timeout = intOr(current('timeout'), 20000)
          if (timeout !== intOr(cloudValue.timeoutMs, 20000)) ops.push({ op: 'set', path: ['cloud', 'timeoutMs'], value: timeout })
          var retries = intOr(current('retries'), 2)
          if (retries !== intOr(cloudValue.retries, 2)) ops.push({ op: 'set', path: ['cloud', 'retries'], value: retries })
          var insecure = current('insecureTls') === true
          if (insecure !== (cloudValue.insecureTls === true)) ops.push({ op: 'set', path: ['cloud', 'insecureTls'], value: insecure })
          return ops
        }

        function save() {
          if (!ready || state.writable === false || phase === 'saving' || !dirty) return
          var found = validate()
          if (Object.keys(found).length) {
            setErrors(found)
            setPhase('failed')
            setToast({ kind: 'bad', text: '还有必填项没填对，见输入框下方的提示' })
            return
          }
          var ops = operations()
          if (!ops.length) {
            setPhase('saved')
            setToast({ kind: 'info', text: '没有改动，未写入配置' })
            return
          }
          setPhase('saving')
          setErrors({})
          setToast(null)
          var mode = current('mode')
          form
            .mutate(ops, state.revision)
            .then(function (accepted) {
              if (!accepted) {
                setPhase('failed')
                setToast({ kind: 'bad', text: '保存失败：宿主拒绝了这次写入（设置可能在别处被改过，请重试）' })
                refreshStatus()
                return
              }
              setPhase('saved')
              setToast({
                kind: 'ok',
                text: '已保存，后端已切换到「' + (mode === 'cloud' ? '云端（WebDAV）' : '本地目录') + '」模式',
              })
              setDraft(null)
              refreshStatus()
            })
            .catch(function (error) {
              setPhase('failed')
              setToast({ kind: 'bad', text: '保存失败：' + String((error && error.message) || error) })
              refreshStatus()
            })
        }

        function runTest() {
          if (test && test.phase === 'running') return
          var found = validate()
          if (Object.keys(found).length) {
            setErrors(found)
            setTest({ phase: 'failed', kind: 'bad', text: '先把必填项填对再测试' })
            return
          }
          setTest({ phase: 'running', text: '正在连接…' })
          jpost('/test', {
            mode: current('mode'),
            local: { root: trimmed(current('localRoot')) },
            cloud: {
              url: trimmed(current('url')),
              username: trimmed(current('username')),
              password: current('password'),
              cacheDir: trimmed(current('cacheDir')),
              refreshTtlMs: intOr(current('ttl'), 60000),
              timeoutMs: intOr(current('timeout'), 20000),
              retries: intOr(current('retries'), 2),
              insecureTls: current('insecureTls') === true,
            },
            write: writeTest === true,
          })
            .then(function (data) {
              if (data && data.ok) {
                var bits = ['读取 ✓']
                if (data.write === true) bits.push('写入 ✓')
                if (data.write === false) bits.push('写入 ✗（' + (data.writeCode || '无权限') + '）')
                setTest({
                  phase: 'done',
                  kind: data.write === false ? 'bad' : 'ok',
                  text: '连接成功：' + bits.join('，') + ' · 延迟 ' + (data.latencyMs || 0) + 'ms',
                })
              } else {
                setTest({
                  phase: 'failed',
                  kind: 'bad',
                  text: (data && data.code ? data.code + '：' : '') + ((data && data.message) || '连接失败'),
                })
              }
            })
            .catch(function (error) {
              setTest({ phase: 'failed', kind: 'bad', text: '请求测试接口失败：' + String((error && error.message) || error) })
            })
        }

        function importLegacy() {
          jget('/legacy?secret=1')
            .then(function (data) {
              if (!data || data.ok !== true || data.found !== true) {
                setToast({ kind: 'info', text: (data && data.message) || '没有找到旧配置' })
                return
              }
              var next = {}
              var base = draft || {}
              for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k]
              next.mode = 'cloud'
              next.url = data.url || next.url || ''
              next.username = data.username || next.username || ''
              if (data.password) next.password = data.password
              setDraft(next)
              setPhase('idle')
              setToast({
                kind: 'info',
                text: data.passwordSet
                  ? '已填入旧配置的地址/账号；密码不会回传，请手动填写后再保存'
                  : '已填入旧配置（~/.config/agentmemory-webdav.json），确认后点保存',
              })
            })
            .catch(function (error) {
              setToast({ kind: 'bad', text: '读取旧配置失败：' + String((error && error.message) || error) })
            })
        }

        function forceRefresh() {
          setToast({ kind: 'info', text: '正在刷新…' })
          jpost('/refresh', {})
            .then(function (data) {
              if (data && data.ok) {
                var result = data.result || {}
                setToast({
                  kind: 'ok',
                  text:
                    data.mode === 'cloud'
                      ? '已刷新镜像：检查 ' + (result.checked || 0) + ' 个、下载 ' + (result.downloaded || 0) + ' 个、删除 ' + (result.deleted || 0) + ' 个'
                      : '本地模式无需刷新（读的就是磁盘）',
                })
              } else {
                setToast({ kind: 'bad', text: (data && data.code ? data.code + '：' : '') + ((data && data.message) || '刷新失败') })
              }
              refreshStatus()
            })
            .catch(function (error) {
              setToast({ kind: 'bad', text: '刷新失败：' + String((error && error.message) || error) })
            })
        }

        // ── 渲染 ─────────────────────────────────────────────────────────────
        var mode = current('mode')

        /**
         * 初始值基线：全部取自宿主当前值（保存成功后 state.value 更新 ⇒ 基线自动前移）。
         * 文本一律 trim；数字统一成字符串比较（这样用户输 "abc" 也算改动，能看到校验提示）。
         */
        function baselineFrom(v) {
          var cloud = (v && v.cloud) || {}
          var local = (v && v.local) || {}
          return {
            mode: v.mode || 'local',
            localRoot: trimmed(local.root || v.root || ''),
            url: trimmed(cloud.url),
            username: trimmed(cloud.username),
            password: '',
            cacheDir: trimmed(cloud.cacheDir),
            ttl: String(intOr(cloud.refreshTtlMs, 60000)),
            timeout: String(intOr(cloud.timeoutMs, 20000)),
            retries: String(intOr(cloud.retries, 2)),
            insecureTls: cloud.insecureTls === true,
          }
        }

        function currentValue(key) {
          var value = current(key)
          if (key === 'insecureTls') return value === true
          return trimmed(value)
        }

        var baseline = baselineFrom(values)
        var dirtyKeys = []
        for (var fi = 0; fi < EDITABLE_FIELDS.length; fi += 1) {
          var fieldKey = EDITABLE_FIELDS[fi].key
          if (currentValue(fieldKey) !== baseline[fieldKey]) dirtyKeys.push(fieldKey)
        }
        var dirty = dirtyKeys.length > 0

        /** 撤销全部未保存改动：清空草稿与错误，回到宿主当前值。 */
        function resetDraft() {
          setDraft(null)
          setErrors({})
          setPhase('idle')
          setToast({ kind: 'info', text: '已撤销未保存的改动' })
        }
        var children = [
          h('h3', { key: 't' }, '资料库 · 存储模式'),
          h(
            'p',
            { key: 'd', className: 'desc' },
            '本地模式读写本机目录；云端模式以 WebDAV 为真源，检索/列表走本地镜像缓存。切换后下一次工具调用立即生效，不需要重启。',
          ),
        ]

        if (!form) {
          children.push(
            h('div', { key: 'noform', 'data-aml-note': 'info' }, '当前部署没有提供设置表单（configForms 不可用），请直接改 profile 的 cordis.patch.yml。'),
          )
        } else if (!ready) {
          children.push(h('div', { key: 'loading', 'data-aml-note': 'info' }, '读取设置中…'))
        } else {
          children.push(
            h(
              'div',
              { key: 'seg', 'data-aml-seg': '' },
              h('button', { type: 'button', 'data-on': mode === 'local' ? '1' : '0', onClick: function () { edit('mode', 'local') } }, '本地模式'),
              h('button', { type: 'button', 'data-on': mode === 'cloud' ? '1' : '0', onClick: function () { edit('mode', 'cloud') } }, '云端模式（WebDAV）'),
            ),
          )

          if (mode === 'local') {
            children.push(
              h(
                'div',
                { key: 'local', 'data-aml-card': '' },
                field({
                  id: 'localRoot',
                  label: '库根目录（绝对路径）',
                  required: true,
                  value: current('localRoot'),
                  placeholder: (status && status.config && status.config.local && status.config.local.effectiveRoot) || '/root/copyparty/library/Obsidian/AgentMemory',
                  hint:
                    '资料库 .md 所在目录；留空按 AGENTMEMORY_ROOT → 旧配置 localRoot → 默认路径解析。生效值：' +
                    ((status && status.config && status.config.local && status.config.local.effectiveRoot) || '未解析'),
                  error: errors.localRoot,
                  onChange: function (v) { edit('localRoot', v) },
                }),
                h(
                  'p',
                  { className: 'desc' },
                  '兼容性：旧配置里的顶层 root 仍然有效（local.root 优先）；留空时按 AGENTMEMORY_ROOT → 旧 WebDAV 配置的 localRoot → 默认路径解析。',
                ),
                values.root && !localValue.root
                  ? h(
                      'p',
                      { 'data-aml-note': 'info' },
                      '当前生效值来自兼容字段 root：' + values.root + '。在上面填了新路径并保存后，local.root 优先生效。',
                    )
                  : null,
              ),
            )
          } else {
            children.push(
              h(
                'div',
                { key: 'cloud', 'data-aml-card': '' },
                field({
                  id: 'url',
                  label: 'WebDAV 地址',
                  required: true,
                  value: current('url'),
                  placeholder: 'https://dav.example.com/dav/AgentMemory/',
                  hint: '要指到库目录本身（不是服务器根），建议以 / 结尾。',
                  error: errors.url,
                  onChange: function (v) { edit('url', v) },
                }),
                field({
                  id: 'username',
                  label: '账号',
                  required: true,
                  value: current('username'),
                  placeholder: 'WebDAV 用户名',
                  error: errors.username,
                  onChange: function (v) { edit('username', v) },
                }),
                field({
                  id: 'password',
                  label: '密码 / 应用密码',
                  required: !passwordSet,
                  type: 'password',
                  value: current('password'),
                  placeholder: passwordSet ? '已保存（留空表示不修改）' : 'WebDAV 密码',
                  hint: passwordSet ? '密码只写不回显；要换密码直接输入新的。' : '保存在 DSH 的插件配置里（profile 补丁），注意该文件的权限。',
                  error: errors.password,
                  onChange: function (v) { edit('password', v) },
                }),
                h(
                  'details',
                  {
                    key: 'adv',
                    'data-aml-adv': '',
                    open: advanced,
                    onToggle: function (event) { setAdvanced(Boolean(event.currentTarget.open)) },
                  },
                  h('summary', null, '高级（镜像目录 / 刷新间隔 / 超时 / 重试 / TLS）'),
                  field({
                    id: 'cacheDir',
                    label: '本地镜像目录',
                    value: current('cacheDir'),
                    placeholder: (status && status.config && status.config.cloud && status.config.cloud.cacheDir) || '留空=~/.cache/dsh-agentmemory-library/<URL 哈希>',
                    hint: '远端文件的本地缓存；删掉它等于强制全量重新同步。',
                    error: errors.cacheDir,
                    onChange: function (v) { edit('cacheDir', v) },
                  }),
                  h(
                    'div',
                    { 'data-aml-row': '' },
                    field({
                      id: 'ttl',
                      label: '刷新间隔（毫秒）',
                      type: 'number',
                      value: current('ttl'),
                      hint: '0 = 每次工具调用都对账',
                      error: errors.ttl,
                      onChange: function (v) { edit('ttl', v) },
                    }),
                    field({
                      id: 'timeout',
                      label: '请求超时（毫秒）',
                      type: 'number',
                      value: current('timeout'),
                      error: errors.timeout,
                      onChange: function (v) { edit('timeout', v) },
                    }),
                    field({
                      id: 'retries',
                      label: '重试次数',
                      type: 'number',
                      value: current('retries'),
                      error: errors.retries,
                      onChange: function (v) { edit('retries', v) },
                    }),
                  ),
                  h(
                    'label',
                    { 'data-aml-row': '', style: { fontSize: '12px', gap: '6px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: current('insecureTls') === true,
                      onChange: function (event) { edit('insecureTls', Boolean(event.target.checked)) },
                    }),
                    '跳过 TLS 证书校验（仅自签名/内网服务器）',
                  ),
                ),
                h(
                  'div',
                  { key: 'legacy', 'data-aml-row': '' },
                  h('button', { type: 'button', 'data-aml-btn': '', onClick: importLegacy }, '从 ~/.config/agentmemory-webdav.json 导入'),
                ),
              ),
            )
          }

          // 未保存改动提示：放在按钮正上方，任何控件一改就出现，保存成功/撤销后消失。
          if (dirty) {
            children.push(
              h(
                'div',
                { key: 'dirty', 'data-aml-dirty': '', 'data-aml-note': 'warn', role: 'status', 'aria-live': 'polite' },
                '有 ' +
                  dirtyKeys.length +
                  ' 项未保存的改动 —— 点「保存设置」让它生效（或点「撤销改动」还原）',
              ),
            )
          }

          children.push(
            h(
              'div',
              { key: 'actions', 'data-aml-row': '' },
              h(
                'button',
                {
                  type: 'button',
                  'data-aml-btn': '',
                  'data-primary': '1',
                  // 未改动时禁用；保存失败/校验失败时 draft 仍在 ⇒ dirty 仍为 true ⇒ 保持可点
                  disabled: phase === 'saving' || state.writable === false || !dirty,
                  onClick: save,
                },
                phase === 'saving' ? '保存中…' : '保存设置',
              ),
              h(
                'button',
                { type: 'button', 'data-aml-btn': '', disabled: !dirty || phase === 'saving', onClick: resetDraft },
                '撤销改动',
              ),
              h('button', { type: 'button', 'data-aml-btn': '', onClick: runTest, disabled: test && test.phase === 'running' }, '测试连接'),
              mode === 'cloud'
                ? h(
                    'label',
                    { style: { fontSize: '11.5px', display: 'inline-flex', gap: '5px', alignItems: 'center' } },
                    h('input', { type: 'checkbox', checked: writeTest, onChange: function (e) { setWriteTest(Boolean(e.target.checked)) } }),
                    '同时测试写入',
                  )
                : null,
              h('button', { type: 'button', 'data-aml-btn': '', onClick: forceRefresh }, mode === 'cloud' ? '立即刷新镜像' : '刷新状态'),
            ),
          )

          if (toast) children.push(h('div', { key: 'toast', 'data-aml-note': toast.kind, role: 'status' }, toast.text))
          if (test) children.push(h('div', { key: 'test', 'data-aml-note': test.kind || 'info', role: 'status' }, test.text))
        }

        // 状态卡
        if (status) {
          if (status.ok === false && status.errors && status.errors.length) {
            children.push(
              h(
                'div',
                { key: 'cfgerr', 'data-aml-note': 'bad' },
                '配置不完整：' + status.errors.map(function (e) { return e.label + ' — ' + e.message }).join('；'),
              ),
            )
          }
          if (status.ok === true) {
            var s = status.status || {}
            children.push(
              h(
                'div',
                { key: 'status', 'data-aml-card': '' },
                h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, '当前状态 · ' + (s.mode === 'cloud' ? '云端（WebDAV）' : '本地目录')),
                h(
                  'div',
                  { 'data-aml-kv': '' },
                  h('span', null, '文件数'),
                  h('span', null, String(s.files || 0) + '（.md ' + String(s.markdownFiles || 0) + '）'),
                  h('span', null, s.mode === 'cloud' ? 'WebDAV' : '库根'),
                  h('span', { 'data-aml-mono': '' }, s.mode === 'cloud' ? String(s.url || '') : String(s.root || '')),
                  s.mode === 'cloud' ? h('span', null, '本地镜像') : null,
                  s.mode === 'cloud' ? h('span', { 'data-aml-mono': '' }, String(s.mirror || '')) : null,
                  s.mode === 'cloud' ? h('span', null, '上次同步') : null,
                  s.mode === 'cloud' ? h('span', null, fmtTime(s.lastSyncAt)) : null,
                  s.mode === 'cloud' ? h('span', null, '密码') : null,
                  s.mode === 'cloud' ? h('span', null, s.passwordSet ? '已保存' : '未保存') : null,
                  s.mode !== 'cloud' && s.rootSource ? h('span', null, '来源') : null,
                  s.mode !== 'cloud' && s.rootSource ? h('span', null, String(s.rootSource)) : null,
                ),
                s.warning
                  ? h('div', { 'data-aml-note': 'bad' }, (s.warning.code ? s.warning.code + '：' : '') + String(s.warning.message || ''))
                  : null,
                s.lastError
                  ? h('div', { 'data-aml-note': 'bad' }, (s.lastError.code ? s.lastError.code + '：' : '') + String(s.lastError.message || ''))
                  : null,
                s.publish && s.publish.supported === false ? h('div', { 'data-aml-note': 'info' }, '云端模式不跑本地 publish（索引/服务健康/备份在库主机上做）') : null,
              ),
            )
          } else if (!status.errors) {
            children.push(
              h('div', { key: 'statusbad', 'data-aml-note': 'bad' }, (status.code ? status.code + '：' : '') + String(status.message || '状态读取失败')),
            )
          }
        }

        return h('div', { 'data-aml-panel': '' }, children)
      }

      /** 一个带标签/提示/错误行的输入框。 */
      function field(props) {
        var input = h('input', {
          type: props.type || 'text',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          onChange: function (event) {
            props.onChange(event.target.value)
          },
        })
        return h(
          'div',
          { 'data-aml-field': '', key: props.id },
          h('label', null, props.label, props.required ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary,#ff8a80)' } }, ' *') : null),
          input,
          props.error ? h('small', { 'data-err': '1', role: 'alert' }, props.error) : null,
          props.hint && !props.error ? h('small', null, props.hint) : null,
        )
      }

      function apply(ctx) {
        Panel.ctx = ctx
        try {
          var style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-agentmemory-library')
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () {
                style.remove()
              }
            }, 'dsh-agentmemory-library: 设置页样式')
          }
        } catch (error) {
          /* 样式失败不影响功能 */
        }

        var slots
        try {
          slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        } catch (error) {
          slots = ctx.slots
        }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        var registered = false
        try {
          slots.inject(SLOT, function () {
            if (registered) return function () {}
            var dispose = slots.register(
              { name: SLOT, id: NS, order: 35, label: '资料库' },
              function () {
                return h(Panel)
              },
            )
            registered = true
            return function () {
              registered = false
              try {
                dispose()
              } catch (error) {
                /* 已经撤过了 */
              }
            }
          })
        } catch (error) {
          /* 没有设置页槽位就算了；原生「插件设置」仍能编辑（字段都标了 volatile） */
        }
      }

      return { inject: ['slots', 'configForms'], apply: apply }
    },
  })
})()