# MCP 兼容层 · 配置指引

把 AgentMemory 资料库的七个 `library_*` 工具，通过 [MCP](https://modelcontextprotocol.io)（stdio）交给 **DSH 之外**的客户端使用：Claude Code、Codex、Cursor、Cline、n8n，或者你自己写的脚本。

> ⚠️ **这一层不是给 DSH 用的。** DSH 里已经有原生 `library_*` 工具（同一个后端、无额外进程、工具名不带前缀）。把本桥注册成 DSH 的 mcp-client 只会多出七个重复工具和一个常驻子进程，没有任何收益。**先在 DSH 里查一眼 `library_status` 能跑，就说明你不需要这份文档** —— 除非你要给别的工具用。

---

## 1. 先确认三个路径

配置里要填三个绝对路径，先用命令拿到它们的真实值，别照抄示例：

```bash
# ① node 可执行文件（客户端常用裁剪过的环境，PATH 里可能没有 node）
readlink -f "$(which node)"

# ② 桥本体
ls -l <仓库目录>/mcp/server.mjs

# ③ 资料库根目录
ls -d ~/notes          # 换成你的库根
```

上面三条命令的输出就是要填进配置的东西 —— **不要照抄本文档里的示例路径**，那些只是占位符（`/usr/local/bin/node`、`/opt/…`、`/home/you/notes/…`）。clone 到别的目录、换过 node 版本、库放在别处，这三个值就都不一样。

---

## 2. 最小配置（本地模式）

先不接客户端，直接验桥能不能起来。三行 JSON-RPC 喂进去，应该回三行：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"library_status","arguments":{}}}' \
  | node <仓库目录>/mcp/server.mjs
```

三条都对了再往下配客户端。第 2 行应列出七个工具，第 3 行 `result.structuredContent.root` 应指向你的真实库根。日志走 **stderr**（`[agentmemory-mcp] ready …`），不会污染 stdout。

如果第 3 行报 `LIBRARY_ROOT_MISSING`，说明兜底链没找到库根 —— 在环境变量里显式设 `AGENTMEMORY_LOCAL_ROOT`。

---

## 3. 环境变量全表

客户端只能传 `command` / `args` / `env`，所以配置一律走环境变量。键名与插件配置字段一一对应。

### 3.1 模式与库根

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTMEMORY_MODE` | `local` | `local` 或 `cloud` |
| `AGENTMEMORY_LOCAL_ROOT` | 空（走兜底链） | **本地模式库根**，绝对路径。一个库根里放的是若干 `.md` 及其 frontmatter |
| `AGENTMEMORY_ROOT` | 空 | 旧写法，与上者等价；两者都给时 `AGENTMEMORY_LOCAL_ROOT` 优先 |

库根的兜底顺序（都没设时）：

```
AGENTMEMORY_LOCAL_ROOT
  → AGENTMEMORY_ROOT
  → ~/.config/agentmemory-webdav.json 里的 localRoot
  → 内置默认
```

读不到就抛 `LIBRARY_ROOT_MISSING`，**不会静默写进别的目录**。这条是有意为之：写错库根比报错更危险。

### 3.2 云端模式（WebDAV）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTMEMORY_CLOUD_URL` | 空 | 必填，指到库目录，建议 `/` 结尾 |
| `AGENTMEMORY_CLOUD_USERNAME` | 空 | 必填 |
| `AGENTMEMORY_CLOUD_PASSWORD` | 空 | 必填。**不要写进会被提交的配置文件**，见 §5 |
| `AGENTMEMORY_CLOUD_CACHE_DIR` | `~/.cache/dsh-agentmemory-library/<hash>` | 本地镜像目录（绝对路径） |
| `AGENTMEMORY_CLOUD_REFRESH_TTL_MS` | `60000` | 镜像与服务端对账间隔；`0` = 每次调用都对账 |
| `AGENTMEMORY_CLOUD_TIMEOUT_MS` | `20000` | 单次 WebDAV 请求超时 |
| `AGENTMEMORY_CLOUD_RETRIES` | `2` | 网络类失败重试次数 |
| `AGENTMEMORY_CLOUD_INSECURE_TLS` | 未设 | 设 `1` 跳过证书校验；**只对自签名内网库开** |

云端模式下：**读**走本地镜像（按 TTL 对账），**写**是写穿（先 `PUT` 到 WebDAV，成功后再更新镜像）。连不上服务端时仍然能读，结果会带 `stale: true`。

### 3.3 其余

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTMEMORY_PUBLISH_SCRIPT` | 自动探测 | `library_publish` 调用的脚本。探测顺序 `$DSH_HOME/skills/…` → `$DSH_AGENTS_HOME/skills/…`（默认 `~/.agents/skills`），取第一个存在的 `agentmemory-library/scripts/publish.sh` |
| `AGENTMEMORY_DEFAULT_LIMIT` | `10` | `library_search` / `library_list` 默认条数 |
| `AGENTMEMORY_MAX_READ_BYTES` | `524288` | 单篇读回上限（512 KB），超出报错而不是截断 |

`library_publish` 只在**本地模式**可用，云端模式一定回 `PUBLISH_CLOUD_UNSUPPORTED`。

---

## 4. 各客户端怎么配

所有 MCP stdio 客户端的形状都一样：`command` + `args` + `env`，差别只在文件名与字段名。

### 4.1 Claude Code

`~/.claude/mcp.json`（或项目内 `.mcp.json`）：

```jsonc
{
  "mcpServers": {
    "agentmemory-library": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/dsh-agentmemory-library/mcp/server.mjs"],
      "env": {
        "AGENTMEMORY_MODE": "local",
        "AGENTMEMORY_LOCAL_ROOT": "/home/you/notes/AgentMemory"
      }
    }
  }
}
```

命令行等价写法：

```bash
claude mcp add agentmemory-library \
  --env AGENTMEMORY_MODE=local \
  --env AGENTMEMORY_LOCAL_ROOT=/home/you/notes/AgentMemory \
  -- /usr/local/bin/node /opt/dsh-agentmemory-library/mcp/server.mjs
```

### 4.2 Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.agentmemory-library]
command = "/usr/local/bin/node"
args = ["/opt/dsh-agentmemory-library/mcp/server.mjs"]

[mcp_servers.agentmemory-library.env]
AGENTMEMORY_MODE = "local"
AGENTMEMORY_LOCAL_ROOT = "/home/you/notes/AgentMemory"
```

### 4.3 Cursor / Cline / 通用 `mcpServers`

```jsonc
{
  "mcpServers": {
    "agentmemory-library": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/dsh-agentmemory-library/mcp/server.mjs"],
      "env": { "AGENTMEMORY_MODE": "local" }
      // 不设库根也行：会走 §3.1 的兜底链
    }
  }
}
```

Cursor 的位置是 `~/.cursor/mcp.json`（或项目内 `.cursor/mcp.json`）；Cline 在设置页的「MCP Servers」里选编辑 JSON。

### 4.4 n8n

n8n 的 MCP 节点选 **Command Line / stdio**，命令与参数分两栏填：

```
Command:  /usr/local/bin/node
Args:     /opt/dsh-agentmemory-library/mcp/server.mjs
Env:      AGENTMEMORY_MODE=local
          AGENTMEMORY_LOCAL_ROOT=/home/you/notes/AgentMemory
```

n8n 会在容器里跑，注意把库根**挂载进容器**并改成容器内路径 —— 宿主机路径在容器里通常不存在。

### 4.5 自己写脚本

最省事的做法：起一个子进程，写一行、读一行。**不要**用 `subprocess.run` 每次只发一条就退出 —— 桥是长驻服务，`initialize` 之后才能 `tools/call`。

Python：

```python
import json, subprocess, sys

proc = subprocess.Popen(
    ["/usr/local/bin/node",
     "/opt/dsh-agentmemory-library/mcp/server.mjs"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)

def call(method, params=None, _id=1):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": _id,
                                 "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    while True:                                   # 跳过服务端主动通知（没有 id）
        msg = json.loads(proc.stdout.readline())
        if msg.get("id") == _id:
            return msg

call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}}, 1)
res = call("tools/call", {"name": "library_search",
                          "arguments": {"query": "掉盘", "limit": 3}}, 2)
print(res["result"]["structuredContent"]["hits"])
```

Node：

```js
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const child = spawn('/usr/local/bin/node',
  ['/opt/dsh-agentmemory-library/mcp/server.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: child.stdout })
const pending = new Map()

rl.on('line', (line) => {
  const msg = JSON.parse(line)
  const resolve = pending.get(msg.id)
  if (resolve) { pending.delete(msg.id); resolve(msg) }
})
const call = (id, method, params = {}) =>
  new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
const res = await call(2, 'tools/call', { name: 'library_status', arguments: {} })
console.log(res.result.structuredContent)
child.kill()
```

工具名在客户端侧**就是原名**（`library_search`），前缀是客户端按 server 名自己加的，桥这边不加。

---

## 5. 密码不要写进仓库

`AGENTMEMORY_CLOUD_PASSWORD` 是唯一的敏感项。三种避免落盘的做法：

1. **客户端支持 `envFile` 就用它**，指向 `~/.config/agentmemory.env`（`chmod 600`，不进版本控制）。
2. **用 shell 包装**：配置文件里写 `command: "sh"`、`args: ["-c", "source ~/.config/agentmemory.env && exec node /path/to/server.mjs"]`。
3. **复用插件已有的凭据**：不设 `AGENTMEMORY_CLOUD_*`，让桥回落到 `~/.config/agentmemory-webdav.json`（如果你已经在用 DSH 设置页配置过云端模式，这个文件里就有）。此时两个进程读的是同一份凭据。

> 已经不小心提交过密码：先 **改 WebDAV 密码**，再清历史（`git filter-repo`）。只删文件不够 —— 历史里还在。

---

## 6. 验证配好了

```bash
# ① 桥自己能跑（不依赖客户端）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  | node <仓库目录>/mcp/server.mjs | head -1

# ② 仓库自带自测：6 项只读 / 加 --write 是 10 项
node <仓库目录>/scripts/test-mcp.mjs
node <仓库目录>/scripts/test-mcp.mjs --write

# ③ 用与客户端完全相同的 env 复现一次，确认库根对不对
AGENTMEMORY_MODE=local AGENTMEMORY_LOCAL_ROOT=/your/root \
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
                '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"library_status","arguments":{}}}' \
  | node <仓库目录>/mcp/server.mjs | tail -1
```

第 ③ 步输出的 `root` 和 `rootSource` 就是客户端会用的库根。对不上通常是 `command` 用了相对路径，或者客户端没把 `env` 传下去。

---

## 7. 排错

| 现象 | 先看哪里 |
|---|---|
| 客户端里没有这七个工具 | `command` 是否绝对路径；手工喂 `initialize` 能否回包 |
| 启动即退 | 桥的 stderr；`CONFIG_INVALID` 会带字段级 `details` |
| `LIBRARY_ROOT_MISSING` | 显式设 `AGENTMEMORY_LOCAL_ROOT`；或跑 §3.1 的兜底链排查 |
| 读不到内容 / 读到别处 | `library_status` 比对 `root` 与 `rootSource` |
| 写入后 Obsidian 索引页没变 | 正常：检索不读索引。要索引跟上就调 `library_publish` |
| 云端一直 `stale: true` | `library_status` 加 `{"probe": true}`，看 `probe.code`（`CLOUD_AUTH_FAILED` / `CLOUD_UNREACHABLE` / `CLOUD_DNS_FAILED`） |
| 覆盖写没生效（`CLOUD_WRITE_NOT_APPLIED`） | WebDAV 服务端缺删除权限，把覆盖写另存成了 `xxx-时间戳.md`；先 `library_read` 确认，别盲目重试 |
| 在 DSH 里看到带前缀的重复工具 | 桥被误注册进 DSH 了 —— 删掉 DSH profile 里那条 mcp-client |

---

## 8. 已知限制

1. **只实现 tools 能力**。`resources/list`、`prompts/list` 返回空数组兜底；`tasks` / sampling / elicitation 未实现。
2. **业务失败不升级成协议错误**。`structuredContent.ok === false` 时结果带 `isError: true`，但 JSON-RPC 层仍是正常 `result`，这样调用方看得见 `code`（`PATH_ESCAPES_LIBRARY` / `ABSOLUTE_PATH_NOT_ALLOWED` / `CONFIG_INVALID` / `LIBRARY_ROOT_MISSING` / `AMBIGUOUS_MATCH` …）。只有方法不存在、JSON 解析失败这类才回 JSON-RPC `error`。
3. **路径永远只能落在库根内**。`../../etc/passwd` → `PATH_ESCAPES_LIBRARY`；`/etc/passwd` → `ABSOLUTE_PATH_NOT_ALLOWED`。校验复用 `lib/paths.mjs`，桥里没有第二套实现。
4. **云端模式的镜像是两份**（如果你同时在 DSH 里用）。DSH 插件进程与桥子进程各持一个后端池，镜像缓存与 `.dsh-mirror.json` 互不可见，TTL 内可能读到对方还没同步的快照。要么调小 `AGENTMEMORY_CLOUD_REFRESH_TTL_MS`，要么只让一边写。
5. **stdout 是协议信道**。任何 `console.log` 都会破坏 JSON-RPC 流，调试写 `console.error`。
6. **协议版本**：支持 `2025-06-18` / `2025-03-26` / `2024-11-05`，请求哪个回哪个，都不认则回最新。