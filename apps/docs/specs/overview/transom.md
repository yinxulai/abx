# 传递窗：agent 把做好的东西递给宿主

**一句话：舱内 agent 做出报告 / 图 / PDF，用 `publish` 递出来，宿主直接打开它。**

没有这条通道，agent 的产出就烂在容器里——容器退出即销毁，而用户要的正是那个文件。
传递窗是**唯一**一条「舱内 → 宿主」的主动通道，所以它的形状比它的功能重要：
它不是一个通用出口，只是两张固定形状的交付动作。

## 1. 工具面：只有两个，永远只有两个

| 工具 | 参数 | 做什么 |
|---|---|---|
| `publish(path)` | 舱内绝对路径 | 校验来源 → 复制到交付格 → 记账 → 按类型决定打开还是只显示 |
| `open(name)` | 交付格里的文件名 | 打开**已经递出去**的那一份；只收文件名，不收路径 |

这两条之外**没有第三个工具**，而且**永远不会有** `http_fetch` / `run_shell` 这类东西。
原因不是「这轮先不做」：那样的话传递窗会变成一条从 agent 直通宿主执行的路径，
气闸的全部意义当场归零。加工具等于拆气闸，评审时应当按这个标准看。

`open` 只收**文件名**这一点是结构性的：它没有「给我一条宿主路径」这个参数，
所以「打开宿主任意文件」不是一道需要小心守住的闸，而是**根本表达不出来**的事。

## 2. 链路

```
舱内 agent
  │  stdio MCP（JSON-RPC 2.0，NDJSON）
  ▼
abx-mcp-shim.mjs            ← abx 写、只读单文件挂进舱（`/usr/local/lib/abx/abx-mcp-shim.mjs`）
  │  HTTP POST /mcp，带舱令牌（agent 本来就有，没有新增凭据）
  ▼
气闸舱面（broker）          ← 解出 cellId，交给传递窗处理器
  │
  ▼
传递窗（宿主进程内）        ← 四道闸 → 复制进交付格 → 记账 → 打开 / 显示
  │
  ▼
~/.abx/outbox/<cellId>/     ← 交付格：用户看到的就是这一格
~/.abx/transom.jsonl        ← 交付流水：一件事一行
```

- **shim 是纯 node、无依赖**的一个文件，随会话落盘（`~/.abx/runtime/<cellId>/`）后
  **只读**挂进舱。它的形状由 `mount-policy.ts` 的 `RUNTIME_FILE_SHAPES` 逐字钉住——
  「往舱里挂一个能跑的脚本」不能是「调用方说挂哪儿就挂哪儿」。
- **它只转发**：令牌从 `ABX_CELL_TOKEN` 读（`buildCellEnv` 本来就注入），
  shim 里没有任何凭据，也没有任何判断白名单的逻辑——判断只有宿主那一份。
- **注册是数据**：`packages/contracts/source/agents.ts` 的 `configFiles` 模板里
  写着 `mcpServers.abx = { command: "node", args: ["/usr/local/lib/abx/abx-mcp-shim.mjs"] }`。
  加一个 agent 仍然只是加一条数据，不需要写代码；模板里**没有凭据**。
- 协议只实现 `initialize` / `tools/list` / `tools/call`（外加 `ping`）；通知不回包，
  解析失败回 `-32700`。没有引入 MCP SDK：要用的就是这三个方法，SDK 带进来的是一整套
  会话状态机，而我们没有会话状态。

## 3. 四道闸

每一条都在 `packages/core/source/transom/` 里，并且各有一组用例。

| 闸 | 规则 | 落点 |
|---|---|---|
| **来源在舱内** | `realpath` 之后必须落在这次会话的工作目录或状态目录下；软链指到外面 → 拒绝 | `source.ts`，与共享挂载**同一套**判法（复用，不另写一份） |
| **落点固定** | 只能写进 `~/.abx/outbox/<cellId>/`；重名改名（`report (1).png`），**绝不覆盖** | `outbox.ts` |
| **大小** | 单次上限 64 MiB，超了拒绝，**不截断** | `outbox.ts` |
| **记账** | 每一次交付 / 打开 / 拒绝各一行；写不进去就**把刚复制的那份撤掉** | `service.ts` + `ledger.ts` |

两条容易看漏的取舍：

- **超限为什么不截断**：截断出来的 PDF 打不开、CSV 少一半，用户看到的是「agent 做的东西
  是坏的」。而大文件本来就在这次会话的工作目录里，宿主直接能打开它，用不着走传递窗。
- **为什么拒绝也记账**：审计要回答的是「它试过什么」。一个反复试图 `publish('/etc/passwd')`
  的会话，是这份流水里最该被看见的东西。
- **账写不进去 = 交付不发生**：复制出来的那份会被删掉。审计是产品承诺，不是日志。

流水的字段固定（`toTransomLine` 逐字段白名单取值）：`ts / cellId / agentId / action /
outcome / cellPath / hostPath / fileName / extension / bytes / sha256 / disposition /
opened / openedWith / reason`。舱令牌与任何凭据都**不在**这个形状里。

## 4. 打开还是只显示：白名单为准

判定是一个纯函数（`packages/contracts/source/transom.ts` 的 `classifyDeliverable`），
宿主与 shim 共用：

| 类型 | 处置 |
|---|---|
| `png jpg jpeg gif webp avif pdf txt md csv json log` | **打开**（交给系统默认应用） |
| `html htm svg` | **只显示**——它们能跑脚本 |
| `.app .sh .command .scpt .dmg .pkg .exe .bat .desktop` | **只显示** |
| 没有后缀、以及任何不认识的类型 | **只显示** |

**判定以白名单为准，未知即拒绝。** 黑名单的失败方式是「没列到的那一种被执行了」，
而新后缀每天都可能出现。白名单的失败方式只是「多了一个要手动打开的文件」。

「只显示」= 在文件夹里把它选出来（Linux 上是打开所在目录），**不执行任何东西**。
这是降级，不是失败：东西照样在交付格里，要不要打开由用户决定。

### HTML / SVG 的决定

用系统浏览器打开一个 `file://` 页面，等于让舱内写出来的东西**在宿主上执行**：
它能读本地文件、能往外发请求，而且都发生在舱外。所以**绝不**用系统浏览器自动打开
HTML / SVG。

正确的形态是 abx 自己的预览（不给 `allow-scripts` 的 sandbox iframe、不给网络）。
这一轮**没有做**预览，于是这两类现在与 `.sh` 同路：只显示。
代码里那条理由与这里说的是同一句话（见 `transom.ts` 的 `INLINE_PREVIEW_EXTENSIONS`），
做预览时应当只改处置、不改白名单。

## 5. 打开动作不经过 shell

`opener.ts` 里没有一处把路径拼进命令字符串：命令与参数是一份 **argv 数组**交给
`spawn(shell: false)`。名字叫 `report; rm -rf ~.pdf` 的文件只是一个文件名。

这一条不是靠小心守住的，是靠**结构上无法表达**：那个文件里不存在「拼一条命令」这条路径。

## 6. 证据

| 验的是什么 | 在哪 |
|---|---|
| 两个工具、四道闸、白名单、流水形状、`/mcp` 的鉴权与错误码 | `packages/core/source/transom/*.test.ts`、`broker/mcp.e2e.test.ts`（真 broker、真 HTTP） |
| 跨容器边界的那一半：sha256 两边相同、白名单内打开 / 外只显示、argv 不被拆、账本行数 | `packages/toolkit/scripts/e2e-transom.sh`（真容器 + 真 shim + 真 broker，26 条断言） |

`e2e-transom.sh` 里唯一的替身是「打开」那条命令（`xdg-open` 换成一个记账脚本）：
真实现会弹窗，而脚本里不能弹窗。用例里的 `pwd$(touch pwned).pdf` 反过来说明
「没有经过 shell」：那个文件名原样出现在**一个** argv 里，而 `pwned` 没有被创建。

## 7. 明确不做 / 尚未验证

- **不做**通用文件访问、目录列举、任意宿主路径读取、执行任何命令。
- **不做** HTML/SVG 的自动打开；预览这一轮没有实现。
- **未验证**：macOS / Windows 上的打开命令（只有映射表与单测，没有真机）；
  真实 claude 会不会主动调用这两个工具（验到的是「注册了、链路通了、结果对」）。
