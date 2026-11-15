# 双模式改造方案（local / WebDAV cloud）

> 版本：`dsh-agentmemory-library@0.3.0`
> 范围：配置结构、设置页、后端切换、云端同步与异常处理。
> 本文是**实施记录**，不是提案 —— 所有内容都已在代码与测试里落地。

---

## 1. 目标与约束

需求：保留现有本地模式（文件路径配置、本地存储目录），新增 WebDAV 云端模式
（url / username / password），两套配置互斥、设置页可切换并校验，模式切换后读写走对后端，
云端连接/认证/网络异常有明确处理，且不破坏已有使用方式。

硬约束（沿用插件原有约定）：

1. `apply()` 里绝不 throw —— 抛出去会被 loader 判成 "did not activate"。
2. 写入只能落在库根（云端模式是镜像根）内，路径校验复用 `lib/paths.mjs`。
3. 不经 `ctx.fs` 写文件（会话沙箱策略会拦住资料库目录）。
4. 不新增运行时依赖：WebDAV 客户端用 `node:http(s)` 自己实现。
5. 配置字段全部 `.volatile()` —— 否则 DSH 设置页不投影该字段。

---

## 2. 总体架构

```
                    ┌──────────────────────────────┐
   tool call ──────▶│ index.js                      │
                    │  Config schema（volatile）     │
                    │  currentInspection()          │
                    │    ├ settings.describe() 覆盖  │
                    │    └ inspectConfig → effective │
                    │  BackendPool.get(eff, sig)     │
                    └──────────┬───────────────────┘
                               │
             ┌─────────────────┴──────────────────┐
             ▼                                    ▼
   ┌───────────────────┐                ┌─────────────────────┐
   │ LocalBackend      │                │ CloudBackend        │
   │ root = local.root │                │ mirror = cacheDir   │
   │ 直接 fs 读写       │                │ WebDavClient ⇄ DAV  │
   └─────────┬─────────┘                │ 读=镜像 / 写=写穿    │
             │                          └──────────┬──────────┘
             └──────────────┬──────────────────────┘
                            ▼
                  lib/search.mjs · publish.mjs · replace.mjs
                        （两种模式共用同一套实现）
```

关键取舍：**云端模式不做"直连 WebDAV 的全文检索"**，而是维护本地镜像。
理由：一次 `library_search` 要遍历全部 `.md` 并逐行匹配 —— 直连意味着几十上百个 GET，
慢且对服务端不礼貌；镜像模型把网络成本压到"每次只下载变化的文件"，并且让两种后端
共用同一套检索/替换语义，避免行为漂移（替代方案见 §9）。

---

## 3. 配置结构

### 3.1 Schema（`index.js` 的 `Config`）

```js
{
  mode: 'local' | 'cloud',            // 模式选择（默认 local）
  root: string,                       // 兼容字段 = local.root（local.root 优先）

  local: { root: string },            // 本地模式：库根目录

  cloud: {                            // 云端模式：WebDAV
    url, username, password,          // 必填三项（password 是 secret 角色）
    cacheDir,                         // 本地镜像目录（留空=按 URL 哈希）
    refreshTtlMs, timeoutMs, retries, // 行为参数
    insecureTls,                      // 自签名证书
  },

  publishScript, defaultLimit, maxReadBytes, publishTimeoutMs, guidance,
}
```

字段级说明（用途 / 必填 / 默认）见 `README.md` 的「配置项」两表；本文只讲结构决策：

- **为什么嵌套成 `local` / `cloud` 两组**：需求要求"互斥、避免混淆"。扁平前缀
  （`localRoot` / `cloudUrl`…）也能做到，但设置页和 profile 补丁里读起来分不清归属；
  嵌套结构让 `mode` 只"指向"其中一组，另一组天然是死配置。
- **为什么保留顶层 `root`**：已有用户的 `cordis.patch.yml` / 环境里写的是 `root`。
  schemastery 的 object 校验会**丢掉未声明字段**，不保留就等于静默清空用户的库根。
  保留 + 文档标"兼容字段"是唯一安全的做法。
- **为什么 `password` 标 `role('secret')`**：DSH 的远程读（浏览器）会对 secret 字段脱敏，
  密码永远不会回到页面；"是否已保存"由自家 status 接口回答。写入仍然走宿主配置
  （profile 补丁，明文），README 已注明该文件的权限风险。

### 3.2 归一化与校验（`lib/config.mjs`）

| 函数 | 职责 |
| --- | --- |
| `unwrap()` | 解包 volatile 持有器 `{get()}`；普通值原样返回 |
| `readConfig(raw)` | 把任意形态（持有器/纯值/缺字段/坏数字）读成规范对象 |
| `validateConfig(cfg, {legacy, hasStoredPassword})` | **只校验当前 mode 那一组**，返回字段级 `errors[]` + `warnings[]` |
| `resolveEffective(cfg, {env, legacy})` | 算出生效值：本地库根优先级、镜像目录、来源标签 |
| `inspectConfig()` | 上述三步的组合，一次给出 `{cfg, ok, errors, warnings, effective, passwordSet}` |
| `signatureOf(effective)` | 后端缓存键（模式/路径/URL/账号/密码/超时… 的 sha256 前 16 位） |

本地库根优先级（与旧行为完全一致）：
`local.root` → `root`（兼容） → `AGENTMEMORY_ROOT` → `~/.config/agentmemory-webdav.json:localRoot` → 内置默认。

云端**不从旧配置继承**任何字段：避免"以为连的是 A 站"。旧配置只用于设置页的"一键导入"。

校验规则：

| 字段 | 规则 | code |
| --- | --- | --- |
| `mode` | ∈ {local, cloud} | `BAD_ENUM` |
| `cloud.url` | 非空 + `http(s)://` | `REQUIRED` / `BAD_URL` |
| `cloud.username` | 非空 | `REQUIRED` |
| `cloud.password` | 非空（除非已保存过） | `REQUIRED` |
| `cloud.cacheDir` / `local.root` | 绝对路径 | `RELATIVE_PATH` |
| ttl / timeout / retries | 数值区间 | `BAD_NUMBER` |
| `local.root` 为空 | 只告警 `LOCAL_ROOT_DEFAULTED`（保持旧行为，不拦） | — |

---

## 4. 设置页

### 4.1 挂载方式

`client.js`（浏览器半端，非 ESM，自注册脚本）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-agentmemory-library',
  factory: (require) => ({ inject: ['slots', 'configForms'], apply(ctx) { … } }),
})
```

`apply` 往 `settings.section` 槽注册一项：

```js
slots.register({ name: 'settings.section', id: 'agentmemory-library', order: 35, label: '资料库' }, () => h(Panel))
```

`package.json` 需要 `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] }`
和 `exports['./client']`。没有这一页时，DSH 自带的「插件设置」仍能编辑（字段都是 volatile），
所以设置页是增强而不是唯一入口。

### 4.2 字段与交互

| 控件 | 条件 | 校验 |
| --- | --- | --- |
| 模式分段控件（本地 / 云端） | 总是显示 | 枚举 |
| 库根目录（绝对路径） | `mode=local` | 必填 + 绝对路径 |
| WebDAV 地址 | `mode=cloud` | 必填 + `http(s)://` |
| 账号 | `mode=cloud` | 必填 |
| 密码 / 应用密码 | `mode=cloud` | 未保存过时必填；已保存可留空（占位符提示） |
| 高级：镜像目录 / 刷新间隔 / 超时 / 重试 / TLS | `mode=cloud`，折叠 | 绝对路径 / 数值区间 |
| 保存设置 | 有改动且非保存中 | 未改动时**禁用**；只提交改动过的字段（`{op:'set', path:[…]}`） |
| 撤销改动 | 有改动时 | 清空草稿与错误，回到基线（按钮随之禁用） |
| 测试连接（+ 同时测试写入） | 总是 | 用**草稿值**试连，不必先保存 |
| 从旧配置导入 | `mode=cloud` | 读 `~/.config/agentmemory-webdav.json` |
| 立即刷新镜像 / 刷新状态 | 总是 | 云端触发强制对账 |

保存与提示：

- 通过 `configForms.get(ns).mutate(ops, revision)` 写入 —— 与 DSH 自带设置页同一条路，
  自带 revision 冲突检测（设置被别处改过 → 返回 `false`）。
- 成功：绿色 toast「已保存，后端已切换到「…」模式」；失败：红色 toast 说明原因；
  无改动：提示「没有改动，未写入配置」。
- 保存后立刻 `GET /status` 刷新状态卡；`state.revision` 变化会清空草稿与错误。

状态卡：当前模式、WebDAV/库根、镜像目录、文件数、上次同步、密码是否已保存、最近错误、
`warning`（如 `MIRROR_REMOTE_EMPTY`）。云端且从未同步过时，面板会自动触发一次 `/refresh`
建镜像（只触发一次）。

### 4.3 改动检测（未保存状态）

设置页用**受控组件 + 基线比较**，不依赖 DOM 的 `input` 事件冒泡：

```
baseline = 由宿主当前值算出（文本 trim；数字统一成字符串；TLS 取布尔）
current  = 草稿值（有草稿取草稿，否则取基线）
dirty    = EDITABLE_FIELDS 里任一字段 current !== baseline
```

- `EDITABLE_FIELDS` 是**唯一**的可编辑控件清单（`client.js` 顶部）：模式分段控件、库根、
  WebDAV 地址/账号/密码、镜像目录、三个数字框、TLS 复选框。新增控件必须登记，否则
  「改了但保存按钮还是灰的」。
- 数字框比较的是**字符串**：输入 `abc` 也算改动（否则用户看不到校验提示），保存时再报
  「需在 … 之间」。
- 密码基线永远是空串（服务端不下发明文）；输入非空即算改动，保存后由宿主的新快照刷新基线。
- 兼容字段 `root`：面板显示 `local.root || root`；若显示的是兼容字段而用户把它清空，
  保存时发 `{op:'unset', path:['root']}` —— 否则保存后基线又回落到旧值，按钮永远灰不下去。
- 按钮：未改动 / 保存中 / 配置只读 → 禁用；保存失败或校验失败 → 保持启用（草稿未丢）。
- 「撤销改动」= 清空草稿 + 错误，回到基线。

### 4.4 服务端接口（`lib/api.mjs`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/agentmemory-library/status` | 配置体检 + 后端状态（`?probe=1` 真连一次） |
| POST | `/api/agentmemory-library/test` | 用草稿值试连：本地查目录可读写；云端 `PROPFIND`（可选 `PUT`+`DELETE` 探针） |
| POST | `/api/agentmemory-library/refresh` | 云端强制对账；本地返回"无需刷新" |
| GET | `/api/agentmemory-library/legacy` | 旧配置一键导入（`?secret=1` 才返回密码） |

两道鉴权：`connection.requestRejection({headers})`（DSH 信任栅栏）+ 本机同源
（`Host` 必须是 127.0.0.1/localhost，`Origin/Referer` 端口也要一致）。
所有响应都是 JSON `{ok, code?, message?, …}`；配置错误返回 HTTP 200 + `ok:false`，
让页面能逐字段展示，而不是只看到一个 500。

---

## 5. 模式切换逻辑

### 5.1 每次都重算配置

```js
currentInspection() =
  mergeConfig(apply 收到的 config, ctx.settings.describe() 里 ns=agentmemory-library 的 value)
  → inspectConfig(...)
```

为什么要合并两份：`apply(ctx, config)` 收到的是 fiber config，volatile 字段是**活持有器**，
设置页一改就变；但某些宿主形态下它只是挂载时快照。再用 `describe()` 的 `value` 盖一层，
两种形态都能拿到最新值。`describe()` 会扫全部插件条目，所以做了 2 秒缓存。

### 5.2 后端池

```js
const backend = pool.get(effective, signatureOf(effective))
```

- 同一份生效配置复用同一个实例（云端后端的镜像状态必须跨调用保留）。
- 签名里含模式 / 库根 / URL / 账号 / 密码 / 镜像目录 / 超时 / 重试 —— 任一变化就换新后端。
  ⇒ 设置页保存后，**下一次工具调用**就切过去了，不需要重启、也不需要重新挂载插件。
- 配置非法时不换后端，工具返回 `CONFIG_INVALID`（带字段级 `details[]`）。

### 5.3 读写路径对照

| 操作 | local | cloud |
| --- | --- | --- |
| `search` / `list` / `read` | 直接扫 `root` | `ensureFresh()` → 扫镜像 |
| `write` | `writeFile(root,…)` 原子写 | 写前补水 → `PUT` 远端 → 回读校验 → `writeFile(mirror,…)` |
| `replace` | 读 → `computeReplacement` → 原子写 | 读镜像 → `computeReplacement` → `PUT` → 写镜像 |
| `publish` | `runPublish(script)` | 不支持：`PUBLISH_CLOUD_UNSUPPORTED` + 说明 |
| 结果字段 | `{mode:'local', root}` | `{mode:'cloud', root:mirror, mirror}`（读失败降级时带 `stale`, `warning`） |

---

## 6. 云端同步协议（`lib/cloud.mjs` + `lib/webdav.mjs`）

### 6.1 WebDAV 客户端

只用五个动词，全部 `node:http(s)`：

| 动词 | 用途 | 备注 |
| --- | --- | --- |
| `PROPFIND Depth:1` | 列目录 | 不用 `Depth: infinity`（不少服务端 403）；逐层递归，并发 4 |
| `GET` | 下载文件 | 单文件上限 64MB |
| `PUT` | 上传（覆盖） | 自动逐级 `MKCOL` 父目录；`Overwrite: T` |
| `MKCOL` | 建目录 | 405 = 已存在，视为成功 |
| `DELETE` | 删探针/同步删除 | 404 视为已删（幂等） |

URL 拼接按段 `encodeURIComponent`；响应 href 统一相对**库根**解析（Depth:1 会带回目录自己
那一条，按根解析后就是 `rel` 本身，过滤掉即可，否则递归会自环）。

### 6.2 镜像同步

```
manifest = <cacheDir>/.dsh-mirror.json   // {url, syncedAt, files:{rel:{etag,size,mtime}}}
refresh():
  remote = walk()                       // Map<rel, {size, etag, mtime}>
  for rel in remote:
    本地缺失 / etag 变了 / 无 etag 且 size 变了 → 下载（并发 4，单文件失败只记 warning）
  远端没有、镜像有的文件 → 删除
  远端 0 个文件但镜像非空 → 不删，warning MIRROR_REMOTE_EMPTY
  远端文件数 < 镜像的 20%（且镜像 ≥20 个） → 不删，warning MIRROR_MASS_DELETE_GUARD
  单文件 href 先过 resolveInside（防编码斜杠 `a%2F..%2F` 逃出镜像根）
  写回 manifest
```

- **TTL**：`refreshTtlMs` 内不联网；`0` = 每次工具调用都对账。
- **失败退避**：一次失败后在 `max(5s, min(ttl, 60s))` 窗口内不再重试，避免每个工具调用都撞超时。
- **写穿**：`PUT` 成功才写镜像；`PUT` 失败镜像不动（无"本地改了远端没有"的分叉）。
- **写前补水（hydrate）**：`exists` 以**远端**为准。远端有、镜像没有时先 `GET` 补齐再算
  `append`/`create`/`replace` —— 修掉过一版"镜像当真相"导致远端被整份截断的数据丢失缺陷
  （`test/cloud.test.mjs` 有两条回归用例）。
- **写完回读**：PUT 之后 GET 回来逐字节比对。有的服务端（copyparty 没开 `daw`/缺 `d`）
  会把同名覆盖写另存成 `note.md-<时间戳>.md` 并回 201 —— 只看状态码会以为成功，
  实际远端没变、镜像却改了。回读不一致 → `CLOUD_WRITE_NOT_APPLIED`，镜像保持原样；
  回读本身失败（网络抖动）→ `verified:false` + `CLOUD_WRITE_UNVERIFIED` 警告（按已写入处理，
  避免调用方重试导致 append 重复）。PUT 会带 `X-OC-Mtime`（Nextcloud 保留时间；
  copyparty 对发这个头的客户端可免 `daw`，但服务端仍需 `d` 权限）。
- **权限/认证错误不吞**：单文件下载遇到 401/403 直接让整次刷新失败（不是"跳过这个文件"）。
- **隐藏文件不镜像**：库里的 `.sync-state.json` / `.publish-manifest.json` 是同步工具自己的状态，
  不参与检索（`allMarkdown` 本来就跳过点文件），镜像它们只花流量；删除清扫也跳过点文件，
  不跳过会出现"远端删了、镜像里永远留着"。
- **服务端要求**：copyparty 覆盖写要开卷标志 `daw`（否则 PUT 覆盖会另存成 `xxx-时间戳.md`）；
  Cloudflare 后面要开 `no-html`（CF 注入脚本会破坏 PROPFIND 响应）。客户端用 `Depth: 1`，
  因此不依赖 copyparty 的 `dav-inf`。
- 镜像根下只有 `.dsh-mirror.json` 以 `.` 开头，检索/列表天然跳过它。

---

## 7. 异常处理

### 7.1 错误分类（`lib/webdav.mjs`）

网络层异常 → 稳定 code：`CLOUD_TIMEOUT`（ETIMEDOUT/Abort）、`CLOUD_DNS_FAILED`
（ENOTFOUND/EAI_AGAIN）、`CLOUD_UNREACHABLE`（ECONNREFUSED/ENETUNREACH）、
`CLOUD_CONNECTION_RESET`（ECONNRESET/EPIPE）、`CLOUD_TLS_ERROR`（CERT_*/ERR_TLS_*）。
状态码 → `CLOUD_AUTH_FAILED`(401)、`CLOUD_FORBIDDEN`(403)、`CLOUD_NOT_FOUND`(404)、
`CLOUD_UNSUPPORTED`(405)、`CLOUD_CONFLICT`(409)、`CLOUD_LOCKED`(423)、
`CLOUD_RATE_LIMITED`(429)、`CLOUD_NO_SPACE`(507)、`CLOUD_SERVER_ERROR`(5xx)。
重试只针对网络类错误与 429/5xx（`retries` 次，200ms×n 退避）；4xx 不重试。

### 7.2 读/写/状态的差异化处理

| 场景 | 行为 |
| --- | --- |
| 认证失败（401） | 不重试。有镜像 → 读降级（stale）；无镜像 → 报 `CLOUD_AUTH_FAILED`；写直接失败 |
| 网络异常 | 有镜像 → 读降级 + 退避；无镜像 → 报错；写失败且镜像不变 |
| 目录 404 | 报 `CLOUD_NOT_FOUND`，提示 URL 要指到库目录 |
| TLS 失败 | 报 `CLOUD_TLS_ERROR`，提示自签名才开 `insecureTls` |
| 远端变空 | 不删镜像，`MIRROR_REMOTE_EMPTY` 警告 |
| 单文件失败 | 其余文件照常同步，`warning.details[]` 列出前 10 个 |
| 配置非法 | `CONFIG_INVALID` + `details[]`，工具不抛错、不降级到本地 |

**降级结果长这样**（模型能看懂"这是旧副本"）：

```json
{ "ok": true, "mode": "cloud", "total": 2, "stale": true,
  "warning": { "code": "CLOUD_TIMEOUT", "message": "…（本次读取用的是上次同步的镜像，最后同步 2026-11-14T03:00:00Z）", "stale": true } }
```

---

## 8. 代码修改点

| 文件 | 类型 | 关键实现 |
| --- | --- | --- |
| `index.js` | 改 | `Config` 加 `mode` / `local` / `cloud`（全部 volatile）；`currentInspection()` 合并 snapshot 与 `settings.describe()`；`BackendPool` 按签名选后端；6 个工具改为 `await backend.*`；新增 `library_status`；`/api` 路由用 `ctx.inject(['webServer'])` 挂载；prompt section 带当前后端 |
| `lib/config.mjs` | 新 | `unwrap` / `readConfig` / `validateConfig` / `resolveEffective` / `inspectConfig` / `signatureOf` / `readLegacyFile`。纯函数，无宿主依赖 |
| `lib/webdav.mjs` | 新 | 零依赖 WebDAV 客户端 + `parseMultistatus` + 错误归一化 + `probe({write})` |
| `lib/cloud.mjs` | 新 | 镜像同步（TTL/etag/删除保护/退避）、写穿、`replace` 走纯函数、`status()` |
| `lib/backend.mjs` | 新 | `LocalBackend` / `CloudBackend` 统一接口 + `BackendPool`（签名缓存） |
| `lib/api.mjs` | 新 | 四个 JSON 接口 + 信任栅栏 + 同源检查 + 草稿试连 |
| `lib/replace.mjs` | 改 | 抽出纯函数 `computeReplacement(before, opts)`；`replaceInFile` 继续做 fs 部分 |
| `client.js` | 新 | 设置页（模式切换 / 条件字段 / 校验 / 保存提示 / 试连 / 状态卡 / 旧配置导入） |
| `package.json` | 改 | 0.3.0；`exports['./client']`；`dsh.client`；files 加 `client.js` |
| `scripts/check.mjs` | 改 | 语法检查纳入 `client.js` |
| `scripts/test-dsh-host.mjs` | 改 | 7 工具；`library_status`；云端缺配置降级；传原始 config（不传解析后的持有器） |
| `test/*.test.mjs` | 新 | 配置 19 / WebDAV 17 / 云端 21 / 接口 13 / 客户端 4 / 面板渲染 14 |
| `test/helpers/fake-dav.mjs` | 新 | 内存版 WebDAV（认证、5xx、超时、405） |
| `README.md` / `docs/DUAL-MODE.md` | 改/新 | 使用说明与本文 |

### 关键实现思路（三句话版）

1. **配置只在 `lib/config.mjs` 里解释**：模式互斥、旧字段兼容、字段级错误都在这里定，
   `index.js` / API / 设置在别处不再写第二套判定。
2. **后端只按"生效值签名"切换**：工具每次调用重算配置 → 签名 → 拿后端；
   设置页保存后下一次调用自动换后端，不需要重启。
3. **云端 = WebDAV 真源 + 本地镜像**：读走镜像（TTL 对账、失败降级），写走写穿
   （PUT 成功才落镜像），所以两种模式共用同一套检索/替换语义。

---

## 9. 备选方案与取舍

| 方案 | 否决理由 |
| --- | --- |
| 直连 WebDAV 做检索（每次 GET 所有 .md） | 一次检索几十上百个请求；延迟与流量都不可接受；与本地模式的打分/排序容易漂移 |
| 用 rclone / rsync 定时同步，插件只读本地 | 需要额外的定时器与进程管理；写操作无法保证"远端成功才返回"；设置页无法即时生效 |
| 扁平配置键（`cloudUrl` / `localRoot`） | 能做互斥，但 profile 补丁与设置页里看不出归属；嵌套结构让 `mode` 的选择语义更强 |
| 自定义 HTTP API 读写配置 | 会和宿主的 revision/脱敏/补丁写入机制打架；`configForms` 已经是官方通道 |
| 把 WebDAV 密码存到独立 secret 文件 | 需要新增一套存储与迁移；DSH 的 `role('secret')` + 配置补丁已能满足"不回显"，代价是补丁文件里是明文（README 已注明） |

---

## 10. 验收

```bash
node --test test/*.test.mjs     # 138 项全绿
node scripts/check.mjs          # 语法 + manifest 契约
node scripts/test-dsh-host.mjs  # 真 cordis 宿主：7 工具、云端缺配置降级、publish 退出码、dispose
```

手工验收（需重启宿主加载 `client.js`）：

1. 设置 → 资料库：默认显示本地模式与生效库根；保存后 toast 变绿。
2. 切到云端：只出现 WebDAV 三项；留空保存 → 三个字段下方出现红色必填提示。
3. 填错地址 → 「测试连接」返回 `CLOUD_NOT_FOUND`；填错密码 → `CLOUD_AUTH_FAILED`。
4. 填对 → 状态卡出现镜像目录与文件数；`library_status` 显示 `mode=cloud`。
5. 断开网络后调 `library_search`：仍返回结果且 `stale:true`；`library_write` 失败且
   镜像内文件未被改动。
6. 切回本地模式：下一次工具调用 `library_status` 立即变回 `mode=local`（无需重启）。
7. 断开远端后第二次读：仍是 `stale:true`（退避窗口），**不会**返回"库里没有"。
8. 远端有、镜像删掉后 `append`：内容是在远端原文后追加，不是整份覆盖。