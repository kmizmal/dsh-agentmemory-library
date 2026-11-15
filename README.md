# dsh-agentmemory-library

把 **AgentMemory 资料库**（跨会话工作记忆归档）的读写注册成 DSH 原生工具。
装上之后，任何会话都能直接调 `library_search` / `library_read` / `library_write` 等工具，
不必再让模型记得去 `bash` 里跑 `search.mjs`。

**0.3.0 起支持双模式**：

| 模式 | 真源 | 读 | 写 | 适用 |
| --- | --- | --- | --- | --- |
| `local`（默认） | 本机目录 | 直接读磁盘 | 直接落盘（原子写） | 库就在这台机器上（现状） |
| `cloud` | WebDAV | 读**本地镜像缓存**（按 TTL 与服务端对账） | 先 `PUT` 到 WebDAV，成功后再更新镜像 | 库在 NAS / Nextcloud / copyparty 上 |

模式切换只改一个配置项（`mode`），下一次工具调用立刻换后端，**不需要重启**。

## 为什么是插件

skill 只能说「去 shell 里跑脚本」——每次都要一次 shell 启动 + 一次 node 冷启动，而且
模型不必然会想起去跑。原生工具进 wire schema，模型每次组装 prompt 都看得见。

检索、列表、读取的实现是 **`/root/.agents/skills/agentmemory-library/scripts/search.mjs`
的逐行移植**（同样的多词 AND、同样的 `score = 命中行数 + 标题命中 50`、同样的 frontmatter
解析），所以插件搜到的和命令行搜到的结果一致。收尾仍然 spawn 现成的 `publish.sh`
——不重写它，cron 与手工命令行继续用同一份。

云端模式**复用同一套读实现**：WebDAV 只负责把变化同步到本地镜像，检索/列表/读取仍然打在
本机目录上。这样两种模式的行为不会漂移（见 `docs/DUAL-MODE.md` 的取舍说明）。

## 给 DSH 之外的客户端：MCP 兼容层

同一个插件的读写逻辑还能以 **MCP** 的方式对外提供（`mcp/server.mjs`，stdio、零依赖）。
**它只服务非 DSH 的 MCP 客户端** —— Claude Code / Codex / Cursor / n8n / 独立脚本。
在 DSH 内部请直接用原生 `library_*` 工具，**不要**把这一层注册成 DSH 的 mcp-client：
那只会多出七个前缀重复的工具和一份多余的后端缓存。

- 业务逻辑**完全复用** `lib/`，两条接入面的语义、路径校验、错误码一致；
- 客户端侧工具名就是原名（`library_search` 等），前缀由客户端按 server 名自己加；
- 配置走环境变量（`AGENTMEMORY_*`），与插件配置一一对应。

引导：skill `agentmemory-library-mcp`；实现说明与实测记录：`docs/MCP-COMPAT.md`；
自测：`node scripts/test-mcp.mjs [--write]`。

## 安装

```bash
cd /root/dsh/dsh-agentmemory-library
npm pack --ignore-scripts --pack-destination /root/dsh/dist/
dsh plugin --profile web add file:/root/dsh/dist/dsh-agentmemory-library-0.3.0.tgz
# 由 dsh-plugin-manager 的 reconcile() 自动追加进 dsh.profile.bundles（manifest 有 dsh.bundle 即可）
dsh --profile web --dump-config 2>/dev/null | grep agentmemory-library
```

装完必须**重启宿主**才生效（profile 在进程启动时装配；`client.js` 也要靠重启进客户端模块表）。

## 设置页

**需要重启宿主**：`client.js` 是这次新增的浏览器半端，DSH 在启动时装配客户端模块表，
运行中的进程不会自己发现新 bundle（服务端 `index.js` 同理）。重启后进入
**设置 → 资料库**（左侧导航里的一项，`settings.section` 槽）。

> 服务端行为（工具、后端切换）在 `apply()` 重新执行后生效；客户端页要等重启。

页面结构：

```
资料库 · 存储模式
[ 本地模式 ] [ 云端模式（WebDAV） ]        ← 模式切换
┌────────────────────────────────────┐
│ 库根目录（绝对路径） *              │    ← 本地模式只显示这一项
│ /root/copyparty/library/Obsidian/… │
└────────────────────────────────────┘
┌────────────────────────────────────┐
│ WebDAV 地址 *                       │    ← 云端模式显示 url/账号/密码
│ 账号 *                              │
│ 密码 / 应用密码 *                   │
│ ▸ 高级（镜像目录 / 刷新间隔 / 超时 / 重试 / TLS）
└────────────────────────────────────┘
[保存设置] [撤销改动] [测试连接] □同时测试写入 [立即刷新镜像]
```

**改动了才会亮**：

- 页面打开（或撤销后台账干净）时，「保存设置」是**禁用**的；任何一个控件（模式、输入框、
  数字框、密码框、TLS 复选框）与初始值不同，按钮立即变可点，并在按钮上方出现
  「有 N 项未保存的改动 —— 点「保存设置」让它生效」。
- 保存成功：提示消失、按钮回到禁用，**当前值成为新的初始值基线**。
- 保存失败/校验失败：草稿与提示都保留，按钮仍可点。
- 把改动改回初始值：按钮自动禁用、提示消失；「撤销改动」一键回到基线。
- 注意：TLS 复选框与安全模式选择都算改动；「同时测试写入」只是测试参数，不进配置、不算改动。

交互要点：

- **条件字段**：选「本地模式」只出现库根目录；选「云端模式」只出现 WebDAV 三项（+ 高级项）。
  另一组的已填值不会丢，切回去还在。
- **必填校验**：本地模式要求库根目录绝对路径；云端模式要求地址（`http(s)://`）、账号、密码。
  密码已保存过时可以留空（占位符会写「已保存（留空表示不修改）」）。
  错误显示在对应输入框下方；宿主侧还会再校验一次（权威判定）。
- **保存提示**：成功 → 绿色 toast「已保存，后端已切换到「…」模式」；失败 → 红色 toast 说明
  是宿主拒绝（revision 冲突）还是网络异常。没有改动时提示「没有改动，未写入配置」。
- **测试连接**：**保存前**就能试。云端会真的发一次 `PROPFIND`，可选再 `PUT`+`DELETE`
  一个探针文件验证写权限；返回延迟、错误码（`CLOUD_AUTH_FAILED` / `CLOUD_UNREACHABLE` / …）。
- **一键导入**：从 `~/.config/agentmemory-webdav.json` 读旧配置（url / 账号 / 密码 / localRoot）。
- **状态卡**：当前生效库根或镜像目录、文件数、上次同步时间、密码是否已保存、最近的同步错误。

密码是 `role('secret')` 字段，**设置页永远读不到明文**（DSH 的远程读会脱敏），
"是否已保存"由 `/api/agentmemory-library/status` 回答。

## 配置项（`Config`）

两组字段**互斥**：`mode` 决定哪一组生效，另一组原样保留但不参与任何行为。

### 通用

| 键 | 类型 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `mode` | `local` \| `cloud` | `local` | 是 | 存储模式 |
| `root` | string | `''` | 否 | **兼容字段**，等价于 `local.root`（`local.root` 优先）。旧配置不用改 |
| `publishScript` | string | `/root/.agents/skills/agentmemory-library/scripts/publish.sh` | 否 | 收尾脚本（仅本地模式） |
| `defaultLimit` | number | `10` | 否 | 检索/列表默认条数 |
| `maxReadBytes` | number | `524288` | 否 | 整篇读回的字节上限 |
| `publishTimeoutMs` | number | `120000` | 否 | publish 超时 |
| `guidance` | boolean | `true` | 否 | 是否注入 system prompt 用法段 |

### 本地模式（`mode=local`）

| 键 | 类型 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `local.root` | string | `''` | 否（但填了就必须是绝对路径） | 库根目录。留空时按 `AGENTMEMORY_ROOT` → 旧配置 `localRoot` → 内置默认路径解析，保持旧行为 |

### 云端模式（`mode=cloud`）

| 键 | 类型 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cloud.url` | string | `''` | **是** | WebDAV 根地址，指到**库目录**（不是服务器根），建议以 `/` 结尾。**不能**把账号密码写在 URL 里（`user:pass@` 会被拒） |
| `cloud.username` | string | `''` | **是** | WebDAV 账号 |
| `cloud.password` | string（secret） | `''` | **是** | 密码 / 应用专用密码。只写不回显 |
| `cloud.cacheDir` | string | `''` | 否 | 本地镜像目录（绝对路径）。留空 = `~/.cache/dsh-agentmemory-library/<URL sha1 前 12 位>` |
| `cloud.refreshTtlMs` | number | `60000` | 否 | 镜像刷新间隔（0 = 每次工具调用都对账，范围 0–3600000） |
| `cloud.timeoutMs` | number | `20000` | 否 | 单次 WebDAV 请求超时（1000–600000） |
| `cloud.retries` | number | `2` | 否 | 网络类失败/5xx 的重试次数（0–5） |
| `cloud.insecureTls` | boolean | `false` | 否 | 跳过 TLS 证书校验（自签名/内网服务器才开） |

直接改 profile 配置也可以（示例）：

```yaml
- id: agentmemory-library
  name: dsh-agentmemory-library
  config:
    mode: cloud
    cloud:
      url: https://dav.example.com/dav/AgentMemory/
      username: zmal
      password: '******'
      cacheDir: /root/.cache/agentmemory-mirror
      refreshTtlMs: 60000
```

### 云端服务端要求（实测踩过的）

| 服务端 | 要点 |
| --- | --- |
| copyparty | 本插件的客户端只用 `PROPFIND Depth: 1`（copyparty 默认对 `Depth: infinity` 回 403 `propfind-finite-depth`，不需要为它开 `dav-inf`）。写入要给卷 **`d`（delete）权限**：实测 `rwd` 权限下、客户端发 `X-OC-Mtime` 头即可同名覆盖；只给 `rw` 时 copyparty 会把覆盖写另存成 `xxx-时间戳.md`（插件会回读发现并报 `CLOUD_WRITE_NOT_APPLIED`）。也可以直接给卷标志 `daw`。走 Cloudflare 时要开 `no-html`（CF 会给 HTML 响应尾部注入脚本，PROPFIND 的长度/内容会坏掉）并配 `rproxy:1` + `xff-hdr` |
| Nextcloud / ownCloud | 地址形如 `https://host/remote.php/dav/files/<用户>/<目录>/`；建议用「应用专用密码」而不是登录密码 |
| nginx-dav / Apache mod_dav | 需要放开 `PROPFIND / GET / PUT / MKCOL / DELETE`；`client_max_body_size` 要大于最大单篇文档 |

自签名证书（内网 NAS）打开高级里的「跳过 TLS 校验」；正式证书不要开。

## 七个工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `library_search` | `query`（必填）、`tag?`、`titlesOnly?`、`limit?` | 全文检索，多词 AND（按行匹配）；返回 `{ok,total,hits[]}`。云端模式读镜像，连不上时带 `stale:true + warning` |
| `library_list` | `dir?`、`limit?` | 有 `dir` 列该目录；不传 `dir` 按 mtime 列全库最近改动 |
| `library_read` | `path`（必填）、`lines?` | frontmatter 解析结果 + 带行号正文；`lines` 形如 `"40-90"` / `"120"` |
| `library_write` | `path`、`content`（必填）、`mode?`、`publish?` | `overwrite`（默认）/ `create` / `append`；本地=原子写，云端=先 PUT 再更新镜像；内容相同则 `changed:false` |
| `library_replace` | `path`、`oldString`、`newString`、`all?`、`count?`、`publish?` | **精准替换**：只改一处；默认要求唯一命中，多处报 `AMBIGUOUS_MATCH` 并列行号；`all:true` 全替换 |
| `library_publish` | `check?`、`noVerify?` | spawn `publish.sh`，返回真实 `exitCode` 与输出尾部（**仅本地模式**；云端返回 `PUBLISH_CLOUD_UNSUPPORTED`） |
| `library_status` | `probe?` | 当前走哪条后端、生效库根/镜像目录、文件数、上次同步、密码是否已存；`probe:true` 会真的连一次 WebDAV |

所有失败都以 `{ok:false, code, message}` 的结构化结果返回，**从不抛给宿主**——
模型能看到原因，一个坏调用不会打断一回合。

## 模式切换逻辑

```
tool call
  └─ 读配置（volatile 持有器 → 解包；设置页的 describe() 再盖一层）
     └─ validateConfig(只看当前 mode 那一组)
        ├─ mode=local → LocalBackend：root = local.root │ root(旧) │ AGENTMEMORY_ROOT │ 旧配置 localRoot │ 默认
        └─ mode=cloud → CloudBackend：url/username/password（不从旧配置继承）
              ├─ 读：ensureFresh()（TTL 内不联网）→ 从镜像 search/list/read
              └─ 写：写前补水 → PUT 远端 → 回读校验 → 写镜像 → 更新清单
```

- **写前补水**：`exists` 以**远端**为准。远端有、镜像没有的文件（别的客户端刚建 / 上次下载失败），
  写之前先 `GET` 补下来再算 `append`/`create`/`replace` —— 否则会拿空串当原文把远端整份覆盖掉
  （数据丢失级缺陷，`test/cloud.test.mjs` 里有两条回归用例）。
- 后端实例按「生效配置的签名」缓存：模式、库根、URL、账号、密码、镜像目录、超时任一变化，
  下一次调用就换新实例 —— 所以设置页保存后立刻生效，没有"改完要重启"。
- 云端镜像的清单在 `<cacheDir>/.dsh-mirror.json`（记录每个文件的 etag/size/时间），
  用于判断"哪些文件真的变了"。删掉它 = 下次全量重新下载。
- 远端删掉的文件，镜像同步时也会删；**但远端突然返回 0 个文件时不删**（防 URL 填错清空缓存），
  只报 `MIRROR_REMOTE_EMPTY` 告警。

## 异常处理（云端模式）

| code | 触发 | 行为 / 建议 |
| --- | --- | --- |
| `CONFIG_INVALID` | 必填项缺失/格式错 | 工具返回 `details[]`（字段级）；设置页把错误显示在输入框下 |
| `CLOUD_AUTH_FAILED` | 401 | 不重试；提示检查账号/密码/应用专用密码 |
| `CLOUD_FORBIDDEN` | 403 | 账号没有该目录权限 |
| `CLOUD_NOT_FOUND` | 404 | URL 没指到库目录 |
| `CLOUD_UNREACHABLE` | ECONNREFUSED / ENETUNREACH | 检查地址、端口、服务是否在跑 |
| `CLOUD_DNS_FAILED` | ENOTFOUND / EAI_AGAIN | 检查域名拼写与 DNS |
| `CLOUD_TIMEOUT` | 请求超过 `timeoutMs` | 不无限等；可调大超时 |
| `CLOUD_TLS_ERROR` | 证书校验失败 | 自签名证书才打开 `insecureTls` |
| `CLOUD_SERVER_ERROR` / `CLOUD_RATE_LIMITED` | 5xx / 429 | 按 `retries` 指数退避重试；仍失败则报错 |
| `CLOUD_LIBRARY_TOO_LARGE` | 远端文件数 > 20000 | 拒绝整库镜像（防止把巨型 DAV 拖垮） |
| `CLOUD_WRITE_NOT_APPLIED` | PUT 成功但回读内容不一致 | 服务端把覆盖写另存成了新文件名（copyparty 缺 `d`/`daw`）；镜像不会被改，先 `library_read` 确认再决定是否重试（**不要盲目重试 append**） |
| `CLOUD_WRITE_UNVERIFIED` | PUT 成功但回读失败 | 按已写入处理，结果带 `warning`（PUT 已 2xx，报失败会诱发重复 append） |
| `CLOUD_WRITE_NORMALIZED` | 回读只差换行/BOM | 按成功处理（服务端做了归一化），`verified:false` |
| `CLOUD_LIBRARY_TOO_DEEP` | 目录超过 12 层 | 拒绝用残缺清单覆盖镜像（否则深层文件会被当"远端已删"） |
| `MIRROR_MASS_DELETE_GUARD` | 远端文件数骤降到 <20% | 不删本地镜像，只告警（防 URL 指错） |

**读的降级**：远端连不上但镜像里已有内容 → 照常返回，带 `stale:true` 与 `warning`
（"这是上次同步的副本，最后同步时间 …"），并在 5–60 秒退避窗口内不重复撞超时。
**镜像为空 + 连不上 → 直接报错**，绝不返回空结果（空结果会被误读成"库里没有"）。

**写的失败**：先 PUT 后落盘，PUT 失败时镜像**保持原样**，不会出现"本地改了、远端没有"。

## 安全边界：写入只落在库根（或镜像根）内

`lib/paths.mjs` 逐条拒绝，两种模式共用：

| 输入 | code |
| --- | --- |
| 空串 / 纯空白 | `EMPTY_PATH` |
| 绝对路径（`/etc/passwd`） | `ABSOLUTE_PATH_NOT_ALLOWED` |
| 含 NUL 字节 | `NUL_BYTE` |
| `..` 逃逸（`../evil.md`、`主题/../../x`） | `PATH_ESCAPES_LIBRARY` |
| 字符串前缀相同但不在根内 | `PATH_ESCAPES_LIBRARY` |
| 目标是符号链接（`lstat` 判定） | `SYMLINK_WRITE_REFUSED` |
| 最近已存在祖先的 `realpath` 在根外 | `PATH_ESCAPES_LIBRARY` |
| `_index.json` / `_索引.md`（索引生成物） | `INDEX_FILE_WRITE_REFUSED` |

云端模式的写入目标先过同一套校验（相对镜像根），再拼 WebDAV 相对路径 ——
路径不可能逃出 `cloud.url` 指的那个目录。写入本地走**同目录临时文件 + rename**（原子）。

HTTP 接口（`/api/agentmemory-library/*`）有两道闸：DSH 的信任栅栏
（`connection.requestRejection`）+ 本机同源检查。

## 写库与 `publish` 的关系

**写库不需要 publish。** `library_search` / `library_list` 的检索面每次 `readdirSync` + 逐文件
现读（`lib/search.mjs` 的 `allMarkdown()`），`_index.json` 只用于给 system prompt 填
「当前索引 N 个文件」。

`publish.sh` 只服务：Obsidian 里浏览的 `_索引.md`、CLI `search.mjs --index` / `--list` 的元数据、
`upload.mjs`、以及 cron 的重建 —— 所以它是**可选收尾**，攒几处改动跑一次即可。

`publish:true` 之所以是可选参数而不是默认折叠，是因为折叠会带来四个真实故障：

| 折叠的后果 | 现在为什么不这么做 |
| --- | --- |
| 并发写必有一个失败 | `lib/publish.mjs` 的 `publishing` 互斥会抛 `PUBLISH_IN_PROGRESS` |
| 写库成败被备份时效污染 | 退出码 2 含「服务异常/备份过期」；已落盘的写会被报成 `ok:false`，模型随即重试重复写 |
| 一处改动触发全库重建 | 17MB / 219 文件全扫并重写两个生成物（仅索引 165–530ms，整套 1.9s） |
| `publish.sh` 缺失连改字都不行 | 现在只有 publish 报 `PUBLISH_SCRIPT_MISSING` |

云端模式不跑 publish：索引、copyparty 健康、备份时效都属于**持有 WebDAV 数据的那台库主机**，
请在那边用本地模式跑（或直接跑 `publish.sh`）。

## 为什么要 `library_replace`

`library_write` 只能整份覆盖。库里已有 20 万字节级的 `经验库/Linux 与 DSH 环境踩坑.md`，
整份重写既贵（模型要重吐全文）又危险（抄漏一段就丢数据）。2026-11-06 就因为改它被迫走
`bash + python + 提权`，而写库本该不申请提权。

`library_replace` 的语义刻意收窄到**字面量、唯一命中**：

| 情况 | 行为 |
| --- | --- |
| 命中恰好 1 处 | 替换，回报行号与改动前后字节数 |
| 命中多处 | `AMBIGUOUS_MATCH`，列出命中行号，**不动文件** |
| 一处都没命中 | `STRING_NOT_FOUND`，提示逐字符核对（空白/缩进/全角标点） |
| `oldString` 为空 | `BAD_OLD_STRING` |
| `oldString === newString` | `NOOP_REPLACE` |
| `all:true` | 替换全部命中 |
| `count:N` 与实际不符 | `MATCH_COUNT_MISMATCH` |

不做正则、不做模糊匹配——「以为在改 A 实际改了 B」是这类工具最贵的失败模式。
云端模式共用同一个纯函数 `computeReplacement()`，语义完全一致。

## 与脚本的已知差异（有意为之）

1. **行内 tags 会被拆开**。`scripts/search.mjs` 与 `sync.mjs` 把 `tags: [a, b, c]`
   整串当成**一个** tag，于是 `--tag` 对库里行内写法的文件全都无效。插件按逗号拆开。
   `_index.json` 里的 tags 仍由 `sync.mjs` 生成，所以那边保持旧行为。
2. **不做 `process.exit`**。脚本用退出码 0/1/2 表达「有结果 / 无结果 / 用法错」；
   插件返回 `ok:true, total:0` 或 `{ok:false, code}`。

## 测试

```bash
node --test test/*.test.mjs        # 138 项：配置 19 / WebDAV 17 / 云端镜像 21 / 接口 13 / 客户端 4 + 面板渲染 14 / 路径·检索·替换 50
node scripts/check.mjs             # node --check 全量（含 client.js）+ manifest 契约
node scripts/test-dsh-host.mjs     # 真宿主锚点集成（38 次原生调用，7 个工具）
```

- `test/helpers/fake-dav.mjs` 是内存版 WebDAV 服务（PROPFIND/GET/PUT/MKCOL/DELETE），
  测认证、404、5xx 重试、超时、远端删除、空目录保护，全部走本地回环，不碰真库。
- `test/client.test.mjs` 用 jsdom 加载 `client.js`，断言自注册 id、`inject`、槽位注册。
- `test/client-render.test.mjs` 用 **jsdom + React 19 真渲染**设置页：模式切换 → 条件字段 →
  必填校验 → 保存提交的 ops → 测试连接提示 → 状态卡。react/react-dom 装在
  `test/vendor/react-runtime/`（不进 npm 包），缺依赖时这两组测试自动跳过。

`scripts/test-dsh-host.mjs` 必须先 `registerHooks` 把 `@deepseek-ai/` 的解析
`parentURL` 重定向到宿主安装目录——profile 的 `node_modules/@deepseek-ai/` 只有
`cosmokit` 与 `schemastery`，裸 node 直接 import 插件会 `ERR_MODULE_NOT_FOUND`。
运行期不会踩这个坑，因为 `dsh-app-boot` 的 `HostResolvedRootInclude` 会兜底。

**宿主 0.2.2 起还要多挂一个 executor**：`tools.execute()` 的入参变成**批**
`{ calls: [{ id, name, arguments }], signal }`，没有 executor 时直接抛
`ToolExecutorUnavailableError`。

## 回滚

```bash
dsh plugin --profile web remove dsh-agentmemory-library
# 重启宿主
```

资料库、copyparty 服务、cron、`search.mjs` / `publish.sh` 全程不被改动，回滚后一切照旧。
云端模式只在 `<cacheDir>` 下留一份镜像和 `.dsh-mirror.json`，删掉即可。

## 设计约束（写代码前踩过的）

- **必须全局注册**：模型工具列表用 `scope: agent`（Agent 对象，不是 scope key）组装，
  agent 作用域注册永远到不了模型。要按会话裁剪只能用 `ctx.tools.guard()` 或
  per-session prompt section。
- **`apply()` 里绝不 throw**：抛出去会被 loader 报 "did not activate"，桌面端升级成
  拒绝启动 + profile 恢复流程。注册失败只 `logger.error`。
- **每个可编辑字段都要 `.volatile()`**：设置页只投影 volatile 字段；volatile 的代价是
  `apply()` 收到的是 `{get()}` 持有器，读之前必须 `unwrap()`（`lib/config.mjs`）。
- **别把解析后的 config 再喂回 schema**：`ctx.plugin(mod, mod.Config(raw))` 会抛
  `ValidationError: $.mode expected "local" | "cloud" but got {}`（持有器被当原始值）。
- **`tools.register()` 必填 `output: { schema, render }`**。
- **兼容性只看 `engines.dsh`**：manifest 有它时 peerDependencies 全部忽略。
- **不经 `ctx.fs` 写**：那条路带会话的文件沙箱策略，资料库在 `/root/copyparty` 下，
  沙箱里的会话根本写不进去。
- **client bundle 不是 ESM**：`client.js` 用 `window.__ModuleLoader__.load({id,factory})`
  自注册，`id` 必须等于包名；`package.json` 要有 `dsh.client` 与 `./client` 导出。

## 许可

GPL-3.0-or-later，全文见 [LICENSE](LICENSE)。

Copyright (C) 2026 kmizmal
