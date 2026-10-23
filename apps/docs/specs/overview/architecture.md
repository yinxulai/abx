# abx 核心模块架构

> **文档出处**：本篇由 `/home/openclaw/Project/airlock/docs/` 的第一阶段设计稿搬迁而来，
> 已把产品代号、包名（`@airlock/*` → `@abx/*`）与环境变量前缀（`AIRLOCK_*` → `ABX_*`）统一到 abx。
> airlock 那个目录是早期的错误落点，不再是任何文档或代码的正式来源。

---

> ## ⚠️ 这是一份**设计阶段的存档**，不是实现说明
>
> 本文写在写代码之前，里面的模块名、端口、变量名有一部分**没有进实现**——
> 例如它写的 `ABX_BASE_URL` / `abx-placeholder` / 端口 `8721` / `direct` 模式，
> 实际实现里叫 `ANTHROPIC_BASE_URL` / `abx-placeholder-anthropic` / `8788`+`8789`，
> 也没有 `direct` 模式。
>
> **实现说明请看 `README.md`，第一阶段的实测结论看 `PHASE1-REPORT.md`。**
>
> 保留它的理由：里面的威胁模型推导、边界分析和几处「为什么不能这么做」的论证
> 仍然有效，而且正是它们决定了现在的形状。但**任何技术断言都要以代码为准**——
> 下面第 16.1 节就有一条已经被证伪了。

> 配套文档：`design.md`（产品设计：威胁模型 / 设计原则 / 体验 / 演示脚本）。
> **本文只回答一件事：核心模块怎么切、怎么接、不能被破坏的不变量是什么。**
>
> 状态：阶段 0（能力层）· 2026-10-23

---

## 0. 范围与阅读顺序

`design.md` 回答「做什么、为什么」；本文回答「切成几块、每块的边界和接口」。
两处冲突时：**产品取舍看 DESIGN，技术边界看本文。**

本文只覆盖**核心**：`contracts` / `core(broker·policy·session·mounts)` / `apps/app`。
体验层（托盘、面板）与文件闸口（Phase 1）另文。

---

## 1. 目标结构（与 osw 同构）

osw 的组织规约是 **`packages/` 放库、`apps/` 放入口程序**，且**领域逻辑收在单一 `core` 里**。
abx 按语义对位 —— 这是和 abx 合并的前提，不是风格偏好。

```
abx/
├─ apps/
│  ├─ app/                    # @abx/app  —— Electron 主进程 + 托盘【主产物，macOS 优先】
│  └─ docs/                   # @abx/docs —— 文档站【预留，未建】
├─ packages/
│  ├─ contracts/              # @abx/contracts —— 类型 + zod schema + 配置加载（零业务依赖）
│  ├─ core/                   # @abx/core      —— 领域逻辑（见下）
│  │  └─ source/
│  │     ├─ broker/           #   气闸代理
│  │     ├─ policy/           #   出口策略（纯函数）
│  │     ├─ session/          #   会话编排
│  │     └─ mounts/           #   挂载与共享区（§15 / §18）
│  ├─ console/                # @abx/console —— React UI（托盘面板），与 osw 同构
│  └─ toolkit/                # @abx/toolkit —— 构建/测试工具链
└─ （根：package.json / pnpm-workspace / turbo / tsconfig / eslint）
```

**产品形态（2026-10-23 定）**：abx 是**桌面应用**，不是命令行工具。
主界面是 **macOS 托盘菜单**，第一版只做 macOS。因此**没有 `apps/cli`** ——
编排落点移到 `apps/app` 主进程，但**可测试的编排逻辑仍留在 `core`**。

**关键决定 A1：`broker` / `policy` / `session` 不再各自成包，降为 `core` 的内部模块。**

理由：osw 的 `core` 就是这么收的；包的数量越多，合并时要改的 `package.json`、
tsconfig references、边界规则就越多，而这三者本就**同生命周期、同部署单元**，拆包只增加摩擦。
内部仍按目录保持模块边界（见 §2 的模块级规则），可读性不损失。

> 迁移说明：当前 abx 脚手架是 `packages/{broker,policy,session,contracts}` 四包。
> 落地 abx 时按本节合并进 `packages/core`，包名 `@abx/*` → `@abx/*`。

---

## 2. 依赖规则（单向，可被 lint 强制）

```
                 contracts            ← 零业务依赖，浏览器可用（纯类型/纯函数）
                     ▲
        ┌────────────┼────────────┐
        │            │            │
     broker       policy       session      ← core 内部三模块
        │  └──────────┘  (broker → policy)
        └──────────────┬────────────┘
                       ▲
              ┌────────┴────────┐
           apps/app        packages/console
        (主进程/接线)       (只依赖 contracts)
```

规则（建议写进 `check-package-boundaries.mjs`）：

| 规则 | 内容 | 为什么 |
|---|---|---|
| **R1** | `contracts` 不依赖任何内部包 | 它是底座，被所有层引用 |
| **R2** | `core` 只依赖 `contracts`，**不依赖 `apps/*`** | 库不反向依赖入口 |
| **R3** | `core` 内部：`policy` 不依赖 `broker`／`session` | 策略是纯函数，必须能被单独测 |
| **R4** | `broker` 可依赖 `policy`；`session` **不依赖** `broker` | 编排不感知代理实现（只传地址/令牌） |
| **R5** | `console` 只依赖 `contracts`，**不得** import `core` | `core` 用 `node:http`/`node:fs`，进浏览器会炸 |
| **R6** | 只有 `apps/app` 主进程做「接线」（读配置 → 建后端 → 起 broker → 起舱）；**编排逻辑本身住在 `core`** | 单一 composition root，副作用集中，且可在无 GUI 的 Linux 上测 |

**R5 是硬约束**：`console` 与 `core` 之间跨进程通信（走 HTTP/IPC），不共享 Node 代码。

---

## 3. 模块边界总览

```
┌─────────────────────── apps/app（接线 / 生命周期） ──────────────────────┐
│  loadConfig → createBackend(docker|local) → startBroker() → create(sandbox)│
│       ↓ 生成舱令牌、组装舱环境变量、注入占位符                                │
└───────────────┬───────────────────────────────────┬──────────────────────┘
                │                                   │
        ┌───────▼────────┐                  ┌───────▼─────────┐
        │  broker        │                  │  session        │
        │  ┌ server 双面  │                  │  ┌ backend      │
        │  ├ route        │   ┌───────┐      │  ├ docker-backend│
        │  ├ target       │◀──│policy │      │  ├ local-backend │
        │  ├ credentials  │   └───────┘      │  ├ mount-policy  │
        │  ├ forward      │                  │  └ env           │
        │  └ audit        │                  └───────┬─────────┘
        └───────┬────────┘                          │
                │                              ┌────▼─────┐
                │                              │  舱(容器) │
                │◀──── 舱内 agent 的请求 ───────│ 无真密钥  │
                └──── 注入真密钥后出站 ────────▶ 上游域名   │
                                              └──────────┘
```

---

## 4. `contracts` —— 契约与配置

**职责**：定义所有跨模块共享的类型、配置 schema 与**加载管线**。零 I/O 之外的行为。

### 4.1 领域类型（真实符号）

| 类型 | 作用 |
|---|---|
| `abxConfig` | 顶层配置：`upstreams` / `egress` / `broker` / `session` |
| `Upstream` | 一个上游：`id`、`baseUrl`、`authHeader`、密钥来源（环境变量名／文件路径） |
| `EgressRule` | 出口白名单的一条：域名模式 + 绑定到哪个 `Upstream` |
| `BrokerConfig` | 监听地址／端口、审计路径、舱令牌来源 |
| `SessionConfig` | 后端 id、`ResourceLimits`、挂载规则 |
| `SandboxBackendId` | `'docker' \| 'local'` |
| `UpstreamIndex` | `host → Upstream` 的查表结构（由 policy 构建） |
| `AgentDefinition` | agent 定义：id、显示名、`BASE_URL`/`TOKEN` 环境变量名 |

**常量**：`AGENT_DEFINITIONS`、`ABX_CELL_ID_ENV`、`ABX_CELL_TOKEN_ENV`、
`ABX_BROKER_ORIGIN_ENV`、`ABX_UPSTREAM_ID_ENV`、`CONFIG_FILE_NAME`。

### 4.2 配置加载管线（失败即拒绝，不降级）

```
findConfigFile()  →  loadConfig()  →  parseConfig()  →  [expandEnvTree]  →  [findInlineSecrets]
      ↑ 找不到就报 ConfigError            ↑ 逐字段 read* 校验        ↑ 展开 ${ENV}   ↑ 拒绝明文密钥
```

- 所有校验错误经 `IssueCollector` 汇聚，`ConfigError` + `renderIssues()` 一次性输出**全部**问题
  （不是发现第一个就抛），因为配置错误一次性看完才改得动。
- `readers.ts` 的 `readObject/readString/readInt/readNumber/readBoolean/readStringArray`
  是**统一的取值与报错风格**，新字段必须走它们，不要手写 `typeof` 判断。
- `DEFAULT_CONFIG` 提供可运行的最小默认值。

### 4.3 两条硬性不变量

- **I-C1 · 仓内无明文密钥。** `findInlineSecrets()` 扫描配置对象，命中
  `secret-shaped-key`（键名像密钥）或 `secret-shaped-value`（值像密钥）即报错。
  配置**只能写环境变量名或文件路径**，明文一律拒绝。
- **I-C2 · `contracts` 保持浏览器安全。** 不 import `node:*`（除 `node:path` 这类纯计算），
  否则 R5 破。

> 当前实现用 TS 手写校验 + `readers`，未用 zod。zod 已在选型里（与 osw 同版本），
> 是否替换手写校验见 §13 待裁决。

---

## 5. `policy` —— 出口策略（纯函数区）

**职责**：**只做判断，不做 I/O。** 这是整个系统最该被单测覆盖的部分。

| 函数 | 签名语义 |
|---|---|
| `evaluateEgress(host, allowlist) → EgressDecision` | 默认拒绝；命中返回 `allow` + 命中的规则 |
| `buildUpstreamIndex(upstreams) → UpstreamIndex` | 预建 `host → Upstream` 表 |
| `upstreamForHost(index, host) → Upstream \| null` | O(1) 取上游 |
| `matchesDomainPattern(host, pattern)` | 单条模式匹配 |
| `matchesAnyPattern(host, patterns)` | 任一条命中 |
| `isSubdomainOf(host, parent)` | 子域判定 |

**模式语义（三种，来自 DESIGN 4.3）**：

1. 精确域名 —— `api.github.com`
2. 单层通配 —— `*.github.com`（**不匹配** `github.com` 本身，也不跨多级）
3. 全域直通 —— `*`（仅在显式配置时）

解析集中在 `contracts/domain-pattern.ts`（`parseDomainPattern`），
`policy` 只消费解析结果 —— **解析与匹配分离**，避免两处各写一套通配语义。

**I-P1**：`evaluateEgress` 必须是纯函数且默认拒绝；任何「未命中即放行」的写法都是 bug。
**I-P2**：IP 字面量与 `localhost` 必须有明确判定（`isIpv4Literal`），不允许靠通配漏放。

---

## 6. `broker` —— 气闸代理（核心中的核心）

### 6.1 双面监听

同一个进程，**两个监听面**，安全等级不同：

| 面 | 地址 | 令牌校验 | 谁在用 |
|---|---|---|---|
| `host` | `127.0.0.1:<hostPort>` | **不校验** | 宿主的桌面客户端 / 调试 |
| `cell` | 见 §19.1（Docker Desktop 上必须绑 `0.0.0.0`） | **强制校验舱令牌** | 舱内 agent |

**I-B1**：`cell` 面**必须**校验令牌，且校验用**恒定时间比较**（`safeEqual`）。
**I-B2（2026-10-23 实测后修正）**：原定「只绑 docker 网桥地址」**在 Docker Desktop 上做不到** ——
网桥网关活在 VM 里，宿主根本绑不上。改为：**绑 `0.0.0.0` 或宿主局域网 IP**，并把
「来源必须是 docker VM 网段」作为令牌之外的第二道校验（见 §19.1）。

理由不变：局域网内任何机器都能连的代理 = 拿你钥匙的开放中继。
但这条**不能靠 bind 地址来保证**了，只能靠令牌 + 来源网段校验。这是实测换来的代价，必须写清。

### 6.2 单次请求生命周期（12 步，每一步都有拒因）

```
 1. 连接落在哪个面？            → 决定是否需要令牌（BrokerFace: 'host' | 'cell'）
 2. cell 面：取令牌              → header `x-abx-cell` 或挂载目录里的令牌文件
 3. cell 面：safeEqual 校验      → 不符 → 401 + 审计(decision=deny, reason=token)
 4. resolveRoute()              → 解析出 BrokerRoute（上游模式 / 直通模式 / 非法 → 400）
 5. 目标域名从哪来？            → header `x-abx-target`，否则用上游 baseUrl 的 host
 6. evaluateEgress(host)        → 不在白名单 → 403 + 审计(reason=egress)
 7. upstreamForHost()           → 命中白名单但无上游绑定 → 走「直通模式」（仅换凭据）
 8. resolveTarget()             → 组装最终 URL，剔除客户端自带的鉴权头（STRIPPED_AUTH_HEADERS）
 9. resolveUpstreamSecret()     → 从 env / 文件取真密钥；取不到 → 502 + 审计(reason=secret)
10. buildOutboundHeaders()      → 用真密钥覆盖 authHeader（客户端发来的占位符被丢弃）
11. forwardRequest()            → 转发（pickTransport 按协议选 http/https），流式回写响应
12. audit.write()               → 追加一行 JSONL：**决策 / 目标 / 注入是否成功 / 状态 / 耗时**
```

第 9 步的 `SecretValue` 是**唯一承载明文的类型**：`reveal()` 才能取出，
`toString()` / `toJSON()` **主动抛错** —— 从类型层面堵掉「不小心把密钥打进日志/JSON」。
这是本项目最值得保留的设计之一。

### 6.3 路由形态（真实常量）

| 形态 | 常量 | 含义 |
|---|---|---|
| `/u/<upstreamId>/<原路径>` | `UPSTREAM_PATH_PREFIX = '/u/'` | 按上游 id 转发（agent 配 `BASE_URL` 用这个） |
| `/c/...` | `CELL_PATH_PREFIX = '/c/'` | 舱面路径前缀 |
| header `x-abx-target` | `TARGET_HEADER` | 显式指定目标域名（直通模式） |
| header `x-abx-cell` | `CELL_TOKEN_HEADER` | 舱令牌 |
| header `x-abx-cell-id` | `CELL_ID_HEADER` | 舱身份（写进审计） |

**I-B3**：客户端自带的 `authorization` / `x-api-key` 等**必须无条件被丢弃并覆盖**
（`STRIPPED_AUTH_HEADERS`），不允许「有真密钥就用、没有就透传客户端值」。

### 6.4 凭据注入

- 来源二选一：**环境变量** 或 **文件**；`resolveUpstreamSecret()` 返回
  `SecretResolution`（成功带 `SecretValue`，失败带原因：`env-missing` / `file-unreadable` / `empty`）。
- `buildAuthHeaderValue(scheme, secret)` 组装 `Bearer xxx` 之类。
- `collectSecretEnvNames()` 供 `doctor` / 启动时**体检**：哪些环境变量还没配。
- `defaultSecretDependencies` 隔离了 `readFile`，**便于测试注入**（不碰真实文件系统）。

**I-B4**：审计里**绝不写密钥值**，只写「是否注入成功」（`injected: true/false`）。

### 6.5 审计

- `AuditRecord` + `AuditDecision`（放行／拒绝及原因）+ `toAuditLine()` 序列化。
- `AuditSink` 接口 → 两个实现：`createFileAuditSink()`（JSONL 追加）、
  `createMemoryAuditSink()`（测试用）。
- `sanitizeField(value, maxLength)` 截断 & 清洗控制字符，防止日志注入。

**I-B5**：审计是**只追加**的；不提供删除/修改接口。

### 6.6 舱令牌

- `generateCellToken()` 生成；`writeCellTokenFile()` 落盘时 `mode: 0o600`；
  `defaultCellTokenPath()` 与审计文件同目录，文件名 `.abx-cell-token`。
- `startBroker()` 的令牌来源三态：`explicit`（调用方给）／`env`（环境变量）／`ephemeral`（临时生成）。

**待裁决**：令牌如何到达舱内（§12 / §13）—— 目前是写进挂载目录，
但挂载目录可写，需评估泄漏面。

---

## 7. `session` —— 会话编排

### 7.1 `SandboxBackend` 接口（可插拔的关键）

```ts
interface SandboxBackend {
  readonly id: SandboxBackendId
  create(spec: SandboxSpec, io: SandboxIo): Promise<SandboxHandle>
}

interface SandboxHandle { readonly cellId: string; stop(): Promise<void> }
```

- `SandboxSpec`：镜像/命令、挂载 `SandboxMount[]`、环境变量、`ResourceLimits`。
- `SandboxIo`：把 stdin/stdout/stderr 接出来（宿主终端只是**窗口**）。
- `createBackend(id)` 是唯一的工厂入口 —— **换平台只换这一层**。

**I-S1**：`assertNoForbiddenEnv(spec)` 必须在 `create` 之前被执行，
禁止把宿主敏感环境变量带进舱（与 `DANGEROUS_HOST_ENV_NAMES` 配套）。

### 7.2 `docker` 后端（主实现）

- `buildDockerArgs(spec, mounts)` 是**纯函数**产出 argv —— 可单测，不真起容器。
- 要点：`--rm` 一次性、非 root、无 sudo、`--memory`/`--pids-limit`/CPU 限额、
  网络只通往 broker。
- `probeDocker()` + `isExecutableOnPath()` 供 `doctor` 用。

### 7.3 `local` 后端（**不是沙箱**）

- 显式导出 `LOCAL_BACKEND_WARNING`，代码里标注「**禁止用于演示**」。
- 存在理由：本机 docker daemon 未起、`bwrap` 因 userns 被禁（`probeUserNamespaces()` 探测）。
- **I-S2**：`local` 后端只做环境注入 + 目录切换，**不得**声称任何隔离；
  CLI 在 `local` 模式下必须把警告打到 stderr。

### 7.4 挂载策略

`MOUNT_POLICY.buildMounts(taskDir, workdir)` + `assertMountPolicy()`：

- `FORBIDDEN_MOUNT_PREFIXES`：`~/.ssh`、`~/.aws`、`~/.config`、钥匙串等**永不挂载**。
- `DOCKER_SOCKET_PATH`：docker socket 是**逃逸后门**，必须显式禁止。
- `DANGEROUS_TASK_DIRS`：把 `$HOME` 或 `/` 当任务目录 → 直接拒。
- `findRiskyFilesInTaskDir()`：任务目录里已有 `.env` / 密钥文件时提示。
- `isForbiddenMountSource()`：供符号链接防护引用。

**I-S3**（安全关键）：`assertMountPolicy()` 在**每一次** `create` 前必经；
任何绕过它直接建容器的路径都是漏洞。

### 7.5 环境清洗

- `scrubEnv()` 剔除 `DANGEROUS_HOST_ENV_NAMES`，返回 `ScrubEnvResult`。
- `buildCellEnv()` 组装舱内环境：`<AGENT>_BASE_URL` 指向 broker 舱面、
  `<AGENT>_AUTH_TOKEN` 填**占位符**、`ABX_CELL_ID`/`ABX_CELL_TOKEN`/`ABX_BROKER_ORIGIN`。
- `generateCellId(agentId, now)` —— 可注入时间，便于测试。

**I-S4**：舱内环境里**永不出现真密钥**；占位符是固定串，broker 无条件替换。

### 7.6 会话状态机

```
idle ──open()──▶ preparing ──create()──▶ running ──stop()/exit──▶ reclaimed
                    │                        │
                校验失败/策略拒绝            异常退出
                    ▼                        ▼
                 rejected                 failed ──▶ reclaimed
```

- `running` 是唯一接受 agent I/O 的状态；
- `reclaimed` 意味着容器已销毁、临时令牌已失效（`--rm` 由 docker 保证）；
- **I-S5**：会话**一次性**（默认）；「工作舱」保留模式是后续增强，需显式开关。

---

## 8. `apps/app` —— Composition Root（Electron 主进程）

它是**唯一**允许把上面所有模块拼起来的地方。对用户暴露的不是命令，而是**托盘动作**：

| 托盘动作 | 落到 core 的调用 |
|---|---|
| 启动 Claude Code / Codex / dsh | `session.create(spec)` + 注入 broker 地址 |
| 拖入文件到共享区 | `mounts.addSharedEntries(paths)`（§18） |
| 共享条目「移除」 | `mounts.removeSharedEntry(id)` |
| 审计流水 | 读 broker 的 JSONL |
| 体检（原 `doctor`） | `probeDocker()` / `probeUserNamespaces()` / `collectSecretEnvNames()` |

**I-A1**：`apps/app` 主进程里不写业务判断（白名单、挂载规则、会话状态都在 `core`）；
它只做「取配置 → 调 core → 更新托盘」。这样**核心逻辑不依赖 Electron，可在 Linux 上单测**。

> 原 `apps/cli` 已取消（产品形态是桌面应用）。但上面那些动作在 `core` 里
> **仍以函数形式存在** —— 将来要补调试 CLI 是加一层壳，不是重写。

---

## 9. 安全不变量清单（每条都要有对应测试）

| 编号 | 不变量 | 测试手段 |
|---|---|---|
| I-C1 | 配置里出现明文密钥 → 拒绝加载 | `findInlineSecrets` 单测 |
| I-C2 | `contracts` 不引入 `node:*` 重依赖 | 边界 lint |
| I-P1 | 出口默认拒绝 | `evaluateEgress('evil.com', [...])` → deny |
| I-P2 | IP 字面量/`localhost` 有明确判定 | 模式匹配单测 |
| I-B1 | `cell` 面无令牌 → 401 | e2e：不带令牌打舱面 |
| I-B2 | 不绑 `0.0.0.0` | 断言监听配置 |
| I-B3 | 客户端鉴权头被覆盖 | e2e：发假 token，断言上游收到真值 |
| I-B4 | 审计不含密钥 | 断言 JSONL 文本不含密钥串 |
| I-B5 | 审计只追加 | 接口层无删除方法 |
| I-S1 | 敏感宿主环境变量不进舱 | `assertNoForbiddenEnv` 单测 |
| I-S3 | 挂载策略必经 | `assertMountPolicy` 单测 + 容器 argv 快照 |
| I-S4 | 舱内无真密钥 | e2e：舱内 `env` 快照 |
| I-S5 | 会话一次性 | `--rm` 断言 |
| **I-X1** | **拔掉 broker → 舱内请求全部失败**（无后门） | e2e：kill broker 后请求必失败 |

`I-X1` 是演示脚本第 5 步的**否定式证明**，优先级最高 —— 它证明的不是「功能能用」，
而是「没有隐藏通道」。

---

## 10. 错误模型

| 层 | 错误形态 | 出口 |
|---|---|---|
| 配置 | `ConfigError`（含全部 `ConfigIssue`） | CLI 打印全部问题 + 退出码 2 |
| 策略 | `EgressDecision = deny`（不是异常） | broker 转 403 + 审计 |
| broker | `ResolvedFailure`（reason 枚举） | 对应 HTTP 状态码 + 审计 |
| 会话 | `MountPolicyViolation`（构造即拒） | CLI 打印 + 退出码 3 |
| 凭据 | `SecretResolution`（reason 枚举） | 502 + 审计 |

**原则**：**「预期内的失败」用返回值表达，「程序员错误」用异常表达。**
白名单未命中是预期内（返回值），挂载策略被绕过是异常。

---

## 11. 可测试性设计（已具备的边界）

| 层次 | 怎么测 | 现有支撑 |
|---|---|---|
| 纯函数 | 无需 I/O | `policy` 全部、`domain-pattern`、`buildDockerArgs`、`buildCellEnv` |
| 依赖注入 | 替换文件/时间/env | `SecretDependencies`、`generateCellId(now)`、`probeUserNamespaces(readFile)` |
| 内存替身 | 不落盘 | `createMemoryAuditSink()` |
| 端到端 | 真进程 | `broker.e2e.test.ts`：起 broker + 假上游 + 断言注入/403 |

**测试金字塔**：纯函数 > 注入式单测 > e2e。e2e 只覆盖 **I-B3 / I-B1 / I-X1** 三条不变量，
其余全部在纯函数层 —— 这样 `pnpm test` 能秒级反馈。

---

## 12. 当前缺口（按优先级）

| 缺口 | 说明 | 优先级 |
|---|---|---|
| **G1 · 三个口未落地** | `MOUNT_POLICY` 目前只有 `taskDir` + `workdir`；DESIGN 的 **Inbox（只读）/ Outbox（可写）/ Never** 尚未建模 | 高（Phase 1 的核心） |
| **G2 · 出舱审核缺失** | 写回已存在文件的确认流程没有任何模块承接 | 高 |
| **G3 · 舱令牌投递方式** | 写进可写挂载目录 → 需明确泄漏面与轮换 | 高 |
| **G4 · broker 生命周期归属** | 由 `abx open` 拉起还是独立常驻？多舱共享一个 broker？ | 中 |
| **G5 · MCP 通用凭据通道** | 非 LLM 协议的凭据注入（GitHub token / DB 密码）未设计 | 中 |
| **G6 · 符号链接防护** | `isForbiddenMountSource` 有钩子，但缺「挂载后不跟随越界符号链接」的强制点 | 高（安全） |
| **G7 · 路径一致性 / 大小写** | 舱内 `/work/...` 与宿主真实路径不一致的设计还没定 | 中 |

---

## 13. 待裁决（需要拍板）

1. **zod 还是手写校验？** 现在配置校验是手写 `readers.ts`。
   换 zod 的好处是与 osw 一致、schema 即文档；代价是重写 + 错误信息风格变化。
   → 建议：**保留手写**（错误信息质量更高，且已带全量聚合），zod 只用于**未来新增**的复杂 schema。
2. **舱令牌投递**：环境变量注入（能进 `env` 输出）vs 挂载目录文件（可被 agent 读取）。
   → 建议：**文件 + `0o600` + 每舱一次性**，并确保该文件不在 Outbox 内。
3. **`local` 后端是否保留**：留着能跑通逻辑，但它是**唯一没有隔离的路径**。
   → 建议：**保留**，但加编译期/运行期双重标记，且 `doctor` 默认警告。
4. **broker 单实例多舱 vs 每舱一实例**：
   → 建议：**单实例多舱**（一个 broker 管所有舱，按 `x-abx-cell-id` 区分审计）。
5. **`core` 合并时机**：现在就按单包落地，还是先四包再合并？
   → 建议：**直接在 abx 里按 `packages/core` 落地**，避免二次搬迁。

---

## 14. 演进路径（与 DESIGN 的分阶段对齐）

| 阶段 | 架构增量 |
|---|---|
| **0 · 能力层（当前）** | `contracts` + `core(broker/policy/session/mounts)`；补 G1/G2/G3/G6；**托盘骨架 + 共享挂载（§18）** |
| **1 · 文件闸口** | `core/mounts` 完成禁区 + 符号链接校验 + `review`（出舱审核）；`session` 消费 |
| **2 · 体验层完善** | `packages/console` 面板（状态灯 / 产出通知 / 审计可视化）；经 HTTP 与 core 通信（R5） |
| **3 · 接入 osw** | 气闸唯一下游改为 OSW 本地地址（`127.0.0.1:19300`）；自研直连上游降级为开发期能力 |
| **未来（不实现）** | FUSE 文件闸口：open/write/unlink 全过策略进程 |

---

## 15. 文件闸口详细设计（G1 / G2 / G6）

> 这一节回答一个必须先想清楚的问题：**bind mount 到底能拦什么、不能拦什么。**
> 想错了会设计出一堆看起来安全、实际无效的防护。

### 15.1 三个口的建模

```ts
type MountRole = 'work' | 'inbox' | 'outbox'

type MountGrant = {
  role: MountRole
  hostPath: string          // 宿主路径（必须 realpath 解析后的真实路径）
  cellPath: string          // 舱内路径；**与宿主保持一致**
  mode: 'ro' | 'rw'
}
```

| 口 | 宿主位置 | 舱内 | 语义 |
|---|---|---|---|
| **Shared** ⭐ | `~/.abx/shared/` | 同路径 | `ro`。**托盘拖入的条目；挂进所有舱**（§18） |
| **Outbox** | `~/.abx/outbox/<cellId>/` | 同路径 | `rw`。**每舱新建空目录** |
| **Work** | 项目目录 | 同路径 | `rw`（见 15.3 的两种模式） |
| **Never** | 不挂载 | 不存在 | `FORBIDDEN_MOUNT_PREFIXES` |

**关键设计 D1：Outbox 必须是「每舱新建的空目录」，不是用户已有的目录。**

这一条是结构性的、不是策略性的 —— 因为 bind mount **无法区分「新建文件」和「覆盖已有文件」**。
只要 Outbox 指向用户已有目录，agent 就能覆盖你自己写的东西，任何审核都来不及。
每舱新建 → **物理上不可能覆盖宿主已有文件**，`outbox` 天然满足 P2（「它给你的永远安全」）。
会话结束时提示「本次产出 N 个文件」，用户自己决定搬去哪。

**关键设计 D2：舱内路径与宿主路径完全一致。**

舱内 `/home/alain/Project/foo/src/a.ts` 就是宿主同一路径。好处：
报错信息、`git diff`、IDE、复制粘贴路径全部一致 —— 省掉 DESIGN 里说的「大量沟通成本」。
代价：容器内要 `mkdir -p` 出同路径骨架（只建到挂载点叶子目录即可）。

### 15.2 符号链接：真正要防的地方在**挂载时**，不在挂载后 ⚠️

**这是对 `design.md` §4.2 第 1 条的修正。**

原文说「必须禁止符号链接指向挂载点之外」。**在容器场景下这句话是无效防护**，原因是：

> 容器内的路径解析发生在**容器自己的 mount namespace** 里。
> 舱内 `ln -s ~/.ssh/id_rsa ./key` 之后读 `./key`，解析的是**容器内**的 `~/.ssh/id_rsa` ——
> 而那个路径根本没挂载，得到的是 `ENOENT`。
> **符号链接无法逃出它所在的挂载命名空间。**

所以「挂载后再防符号链接」是空转。真正的攻击面在**挂载这一刻**：

| 真实风险 | 机理 | 防护 |
|---|---|---|
| **R-a 挂载源本身是符号链接** | docker 在**宿主侧**解析 bind source。若 `~/Project/foo` 是指向 `~/.ssh` 的链接，会把 `.ssh` 挂进去 | 挂载前对每个 `hostPath` 做 `realpath()`，用**解析后**的路径去校验禁止前缀，并用解析后的路径挂载 |
| **R-b 祖先目录是符号链接** | `~/Project` → `~/Library/...`，逐段解析后落到禁止区 | 对 `hostPath` 的**每一级祖先**做 realpath 比对，任一级越界即拒 |
| **R-c 硬链接** | 硬链接是同一文件系统里的真实目录项，**能跨目录暴露内容**（不跨文件系统） | `findRiskyFilesInTaskDir()` 扩展：检出任务目录内 `nlink > 1` 且指向禁止前缀 inode 的条目并告警 |
| **R-d docker socket / privileged** | 挂 socket 或给特权 = 直接逃逸 | `DOCKER_SOCKET_PATH` 硬禁；`--privileged`、`--cap-add` 一律不出现在 `buildDockerArgs` |

**修订后的 I-S3 实现要点**（`assertMountPolicy` 必须做全）：

```
1. hostPath 必须存在且是目录（不接受文件、不接受不存在路径）
2. hostPath = realpath(hostPath)
3. 对 realpath 结果做 FORBIDDEN_MOUNT_PREFIXES 前缀检查（含 ~/.ssh、~/.aws、~/.config、钥匙串）
4. 对每一级祖先重复步骤 2–3
5. 任务目录不得等于 $HOME 或 /（DANGEROUS_TASK_DIRS）
6. 不得与 docker socket 同 inode
7. 校验失败 → MountPolicyViolation（构造即抛，不给绕过机会）
```

**这条修正很值钱**：如果按原文档实现，会写一段「扫描舱内符号链接」的代码 ——
看着很安全，实际一行都不起作用，却让人误以为已经防住了。

### 15.3 出舱审核不是拦截器，是**事务日志**（G2）

bind mount 是**内核级直通**，没有用户态拦截点。所以「agent 要覆盖文件时弹确认」
在 rw 挂载下**技术上做不到** —— 除非上 FUSE（DESIGN §13 的未来项）。

阶段 1 的正确解法是把问题换成「让覆盖变成可撤销」：

| Work 模式 | 机制 | 审核方式 | 默认 |
|---|---|---|---|
| **worktree**（推荐） | `git worktree add` 独立工作区，共享对象库 | 产出天然是**一个分支**；`git diff` / `git merge` 就是审核界面 | ✅ 代码项目默认 |
| **snapshot** | 起舱前 `cp -a` 或 `rsync` 快照 | 出舱时 diff 快照与现态 | 非 git 项目 |
| **direct** | 直接 rw 挂载 | **无审核**，必须显式二次确认 | 高风险，需显式开启 |

**关键设计 D3：把「拦截」换成「分支」。**

git 本身就是最好的审核与回滚机制 —— 它把不可逆的「覆盖」变成了可逆的「合并」。
这也顺手解决了路径一致性问题（worktree 路径结构化，可预测）。

**I-S6（新）**：`direct` 模式必须在 CLI 上要求显式 `--no-review`，且在审计首行记录该会话为 unreviewed。

> **[2026-10-23 更正]** 本节的前提是错的，实测时被推翻了。
>
> 原文断言「Claude Code / Codex …… 没有配置自定义请求头的入口」。
> 实际上 Claude Code 有 `ANTHROPIC_CUSTOM_HEADERS`，可以按 `Name: Value`
> 追加任意请求头。所以实现里把**请求头**作为首选路径，路径前缀只留给
> 确实没有这个入口的 agent（见 `AgentDefinition.cellTokenVia`）。
>
> 这个更正不只是「换个投递方式」：把令牌放进 URL，意味着它会出现在
> agent 自己的输出、上游的 access log、以及任何记录了 URL 的地方；
> 走请求头没有这个问题。原文把路径携带当成「唯一可行的主路径」，
> 于是把最差的那个选项当成了默认选项。
>
> 需要核实的是 `ANTHROPIC_CUSTOM_HEADERS` 的多行格式——实现按换行分隔处理，
> 这一点**尚未对着真实行为验证过**（见 `PHASE1-REPORT.md` 第四节第 2 条）。

---

## 16. 舱令牌投递（G3）

### 16.1 一个绕不开的约束：agent 不会自己加请求头

Claude Code / Codex 只会往 `BASE_URL` 发请求并带自己的 `Authorization`，
**没有配置自定义请求头的入口**。所以 `x-abx-cell` 头只能用于我们自己的客户端，
「舱内 agent」这条主路径必须走**路径携带**：

```
ABX_BASE_URL = http://host.docker.internal:8721/c/<cellToken>/u/osw
ABX_AUTH_TOKEN = abx-placeholder
```

> **实测修正（2026-10-23）**：原稿写的是 `<网桥IP>`。在 Docker Desktop 上这个地址
> **从舱内连不上**（`ECONNREFUSED`），必须用 `host.docker.internal`。macOS 只有 Docker
> Desktop，所以这**不是边例，是主路径**。详见 §19.1。
>
> **上游 id 是 `osw`**：生产形态下气闸的唯一下游就是 OSW，见 `design.md` §12。
> 舱内 agent 的配置里因此只有**一个自定义供应商、一个 baseUrl**——这就是要讲的安全。

这正是 `route.ts` 里 `CELL_PATH_PREFIX = '/c/'` 与
`CellTokenSource = 'header' | 'path'` 存在的原因 —— 两条路都要留。

### 16.2 泄漏面与缓解

| 泄漏途径 | 后果 | 缓解 |
|---|---|---|
| agent 打印 `BASE_URL`（含令牌） | 令牌进入终端输出 / 审计 / 提交 | 每舱一次性 + 舱销毁即失效；**舱面虽绑 `0.0.0.0`，但来源网段校验把非 docker VM 的请求挡在外面**（§19.1） |
| 令牌被写进 Outbox 产物 | 会话结束后仍留在磁盘 | 出舱扫描 `findRiskyFilesInTaskDir` 模式扩展：命中已知令牌串即告警 |
| 令牌进 git 历史 | 永久留存 | 同上；且令牌格式加可识别前缀（如 `abx_cell_`）便于扫描 |

**关键设计 D4：令牌格式带可识别前缀 `abx_cell_`。**
理由：让「泄漏检测」从语义猜测变成字符串匹配，CI / 提交前钩子 / 日志扫描都能用同一条规则。

**I-B6（新）**：舱令牌不得写入任何挂载目录之外的位置；进程退出时必须删除令牌文件。

---

## 17. 对 `design.md` 的修正记录

| 原文位置 | 原文说法 | 修正 |
|---|---|---|
| §4.2 第 1 条 | 「必须禁止符号链接指向挂载点之外」 | 容器内符号链接天然无法跨 mount namespace 逃逸；真正的防护点是**挂载时 realpath 校验**（§15.2） |
| §4.2 第 3 条 | 「建议让两者路径一致」 | 升级为**硬性设计 D2**：舱内路径必须与宿主一致 |
| §4.4 出舱审核 | 「agent 要覆盖文件时弹一次确认」 | rw 挂载下无法拦截；改为 **worktree 分支审核**（§15.3） |

---

## 18. 托盘与共享挂载（macOS 优先）

> 需求原文：「支持文件挂载功能，托盘菜单大概长这样，拖入文件直接就是共享给所有的 agent」。

### 18.1 可行性：Electron 原生支持 ⭐

`Tray` 有**官方**的文件拖入事件，**不需要原生模块**：

| 事件 | 载荷 | 平台 |
|---|---|---|
| `drop-files` | `files: string[]`（落地文件路径） | **macOS only** |
| `drag-enter` / `drag-leave` / `drag-end` | 拖拽进入 / 离开 / 结束 | **macOS only** |
| `drop-text` | 拖入的文本 | macOS only |

**结论：图纸上「拖文件到托盘图标」在 macOS 上是一条官方 API 就能接住的事。**

**代价（必须写进计划）**：三个事件都是 macOS only，所以
**本机 Ubuntu（`DISPLAY` 为空）无法验证这一段**，必须到 Mac 上验。
这与「第一版只做 macOS」一致，但意味着**拖拽相关验证不能在本机完成**。

### 18.2 机制：挂**目录**，不要挂单个文件 ⭐

硬约束：**docker 不能给运行中的容器新增 bind mount。**

| 方案 | 拖入一个文件后 | 结果 |
|---|---|---|
| 逐文件挂载 | 需要重建所有舱 | ❌ 体验灾难（每个 agent 会话被打断） |
| **挂目录 `~/.abx/shared/`** | 文件放进该目录 | ✅ **立刻可见，零重启** |

**这就是「拖入即共享给所有 agent」唯一简单且成立的实现。**

### 18.3 落地方式：怎么把文件放进 `shared/`

| 方式 | 结果 |
|---|---|
| **符号链接** | ❌ **绝对不用** —— 目录级挂载下，舱内解析链接会落到**容器内不存在的路径**，表现为「拖了但 agent 看不到」，最糟的体验 |
| **硬链接** | ✅ 零拷贝（同文件系统） |
| **复制** | ✅ 最可预测；跨文件系统唯一可行（外置盘 / 网络盘） |

**推荐：硬链接优先，跨文件系统自动回退复制**，UI 上标注条目当前是「链接」还是「副本」。

**已知缺陷（写进 UI）**：macOS 上多数编辑器保存是**原子写**（临时文件 + `rename`），
会**断开硬链接**，agent 看到的是旧内容 → 条目提供「重新同步」。

### 18.4 读写语义

`shared/` 整体以 **`ro`** 挂载 —— 因为 `ro`/`rw` 是**每个挂载点**的属性，做不到逐条。

- 给它是**资料**，不是编辑权：拖入的语义是「让它看见」，`ro` 正合 P2
- 需要「多个 agent 互相交换产出」时另开 `shared-rw/`（默认不开，避免共享区变垃圾场）

### 18.5 目录布局

```
~/.abx/
├─ shared/            # 拖入的条目；所有舱 ro 挂载  ← 托盘拖拽落点
├─ outbox/<cellId>/   # 每舱新建空目录；rw（§15.1 D1）
└─ vault/             # 舱令牌等；**永不挂载**
```

### 18.6 托盘菜单结构（对应图纸）

```
◉ abx · 2 个舱在跑
──────────────────────────────
 ⬛ Claude Code     ⬛ Codex     ⬛ dsh      ← 图纸上半：一排三个
──────────────────────────────
 共享给全部 agent           （拖文件到这里）
   ▤ design-spec.pdf          只读
   ▤ api-contract.md          只读          ← 图纸下半：面板里的列表
   ▤ assets/                  只读
──────────────────────────────
 审计流水…        停止全部        退出
```

图纸上排方块 = agent 启动项；下方面板 = 共享条目列表（同时是拖拽落点）。

### 18.7 安全

- 拖入时对源路径做 `realpath` 校验（§15.2 的 R-a / R-b）—— 防「拖进来的其实是指向 `~/.ssh` 的链接」
- 命中密钥形名字（`id_rsa` / `.env` / `*.pem` / `credentials`）→ **二次确认**
- **移除条目只解除挂载，绝不删除原文件**（P5「可恢复」的底线）

### 18.8 待裁决

1. 退出 app 是否清空 `shared/` → **建议保留**，UI 提供「全部清空」
2. 拖入**目录**时：整目录挂载还是展开成条目 → **建议整目录挂载**
3. 硬链接 vs 复制做默认 → **建议硬链接优先 + 不确定的源（外置盘）自动复制**

---

## 19. 真实 Docker 验证（2026-10-23，第一次跑通）

第一阶段报告把「docker 后端没有对着真实守护进程跑过」列为**第一优先缺口**。
本节记录补上这一项后的结果 —— 其中**两条推翻了原有设计假设**。

环境：Docker Desktop for Linux，daemon 在 VM 内，server 29.9.1。

### 19.1 ⚠️ 推翻原假设：`172.17.0.1` 在 Docker Desktop 上不可用

原设计（§6.1 / §16.1）假定：舱面绑 docker 网桥网关，舱内通过它回连宿主。

实测结果：

| 地址 | 宿主能否绑定 | 舱内能否连到 |
|---|---|---|
| `172.17.0.1` | ❌ `EADDRNOTAVAIL` | ❌ `ECONNREFUSED` |
| `host.docker.internal` | —（是 DNS 名） | ✅ `200`，解析到 `192.168.65.2` |
| `0.0.0.0` | ✅ | ✅（经 `host.docker.internal` 访问） |

**原因**：Docker Desktop 把守护进程放在 VM 里。`172.17.0.1` 是**VM 内部**的
`docker0` 网桥，既不属于宿主（所以绑不上），也不指向宿主（所以连过去是 VM 自己）。
`host.docker.internal` 由 Docker 注入 DNS，解析到 VM 的宿主网关（这里是 `192.168.65.2`）。

**为什么这条特别要紧**：abx V1 **只做 macOS**，而 macOS 上**只有** Docker Desktop。
也就是说这个「边例」在目标平台上是**唯一路径**，原默认值 100% 起不来。

**修正后的规则**：

1. `cellHost` 默认 **`0.0.0.0`**（不是网桥地址）
2. 舱内 `BASE_URL` 的 host 用 **`host.docker.internal`**（不是 IP）
3. 原生 Linux docker（非 Desktop）上两者仍可用网桥地址 —— 所以做成**探测后决定**，
   不要硬编码
4. **代价**：绑 `0.0.0.0` 意味着舱面在局域网上可见，`I-B2` 原本靠 bind 地址获得的
   保护消失了。补偿措施：**来源网段校验** —— 非 docker VM 网段（`192.168.65.0/24`
   或 `172.17.0.0/16`）的请求一律拒绝，即便令牌正确

> 这条是本项目第一次「文档说的和机器做的不是一回事」。以后凡涉及网络可达性，
> 一律先探测再断言，不许照抄约定值。

### 19.2 ⚠️ 新发现：挂载源必须在 Docker Desktop 的共享路径内

`--volume /tmp/xxx:/workspace` 直接失败：

```
docker: Error response from daemon: mounts denied:
The path /tmp/abx-taskdir is not shared from the host and is not known to Docker.
```

Docker Desktop 只把特定宿主路径共享给 VM（macOS 默认 `/Users`、`/Volumes`、`/private`、
`/tmp`；本机 Linux 版只共享 `/home`）。**落在共享路径外的任务目录，容器根本起不来。**

**要求**：

- 起舱前对每个挂载源做**共享路径检查**，不在范围内就报一句人话：
  「这个目录在 Docker 的共享范围外，请把项目移到 `~/` 下，或在 Docker 设置里添加该路径」
- 绝不能让用户看到裸的 `mounts denied`
- `~/.abx/shared/` 与 `~/.abx/outbox/` 都在 home 下 → 天然安全，这也是选这个位置的又一个理由

### 19.3 ✅ 隔离性质：逐条实测通过

用 `buildDockerArgs` 真实生成的 argv 起容器（去掉 `--tty/--interactive`，因为无终端），
舱内执行检查：

| 性质 | 实测输出 | 结论 |
|---|---|---|
| 非 root | `uid=1000(node) gid=1000(node)` | ✅ |
| 无 sudo | `command -v sudo` 无输出 | ✅ |
| 根文件系统只读 | `touch /pwned` → `Read-only file system` | ✅ |
| `/tmp` 可写（tmpfs） | `touch /tmp/ok` 成功 | ✅ |
| 无 docker socket | `/var/run/docker.sock` 不存在 | ✅ |
| 任务目录可读写 | `/workspace/note.txt` 可见 | ✅ |
| 环境变量无真密钥 | 只有 `ABX_CELL_TOKEN=abx_cell_placeholder` | ✅ |
| 退出即销毁 | `docker ps -a --filter label=...` 空 | ✅ `--rm` 生效 |
| 舱内可达宿主 broker | 经 `host.docker.internal` 拿到 `200` | ✅（见 §19.1 的地址要求） |

**一处需要更正第一阶段报告的说法**：报告称「容器里 `ls ~` 是空的」，实测**不是空的** ——
`node:22-slim` 镜像自带 `.bashrc` / `.bash_logout` / `.profile` 三个骨架文件。

这不影响安全结论（**没有任何宿主文件**进舱，这才是要验的性质），但**说法必须改**：
应写成「`~` 里只有镜像自带的骨架文件，无任何宿主内容」，否则是把一个没验过的断言
当成了已验证的结论。这类表述以后一律按实测输出写。

### 19.4 仍然没验的

- 真实的 Claude Code / Codex 二进制没有在舱内跑过（替身脚本不是它们）
- `ANTHROPIC_CUSTOM_HEADERS` 的多行格式仍是推断
- 真实 agent 还会连哪些域名（白名单大概率要补）→ 不补的话用户会看到「气闸一开就不好用」
- 对抗性测试：没有任何一步尝试绕过白名单、伪造舱令牌、从舱内往外打
- macOS 真机：以上全部是在 Linux 版 Docker Desktop 上测的。**macOS 的共享路径默认值
  与 VM 网关地址可能不同**，必须在真机重跑一遍

---

## 20. 本轮拍板的决定（2026-10-23 下午）

四条来自产品侧的决定，连同它们各自引出的**待办缺口**。落地时以本节为准。

### 20.1 配置校验改用 zod

**决定**：`contracts` 的配置加载改用 **zod**，替换现在的手写校验。

**理由**：手写校验现在散在 `load-config.ts` 里（`validatePattern` 一类函数逐个字段写），
每加一个字段都要同步改三处：类型、校验、报错文案。zod 让这三样从一个 schema 长出来，
**而且 schema 是运行时可用的对象** —— 后面 `core` 要用它做「配置自检」时不用再写一遍。

**版本对齐**：OSW 用的是 `zod@^4.6.7`（它的根 `package.json`）。**abx 用同一个范围**，
理由与别的依赖一样：合并时要能对上。

> ⚠️ 现有 `IssueCollector` 那套「一次收集全部问题再一起报」的行为**必须保留**。
> zod 默认遇到第一个错误就抛。这里要的是把 `zod` 的 `error.issues` 映射进现有的
> `Issue` 列表，而不是把错误处理改成抛异常 —— 配置文件写错十处，用户应该一次看到十处。

### 20.2 `local` 后端保留

**决定**：`local` 后端**保留**，不删。

**理由**：本机 `DISPLAY` 为空、docker 也曾经起不来 —— 一条「不依赖任何隔离设施就能跑通逻辑」
的路径是**唯一的兜底**。它已经在代码里显式标注「**不是沙箱，禁止用于演示**」，
并且 `isRealSandbox: false` 会让上位强制打警告。这个设计是对的，保留。

**要求**：`local` 后端下必须在**所有**用户可见的输出里标注它不是沙箱，
包括 `audit` 的每一条记录（审计里看不出这条请求是不是被隔离的，就等于审计骗人）。

### 20.3 broker 单实例多舱 ⚠️ 当前实现不满足

**决定**：**一个 broker 进程服务全部舱**，不为每个舱起一个 broker。

**为什么必须这样**：起一个舱就起一个 broker，意味着 N 份配置文件解析、N 个端口、
N 个审计文件、N 份真密钥副本在内存里。**真密钥的副本数量应当与「宿主有几个进程」成正比，
不是与「跑了几个舱」成正比。**

**⚠️ 但当前实现是一个令牌给所有舱用**：

- `resolveCellToken()` 只产出一个令牌，`startBroker` 把它单值地交给 handler
- 舱面校验是 `safeEqual(provided, cellToken)` —— 比的是**同一个值**
- 于是任何一个舱拿到的令牌，**换到另一个舱上同样有效**
- 更糟的是 `cellId` 来自 `ctx-abx-cell-id` 请求头，取不到时兜底成 `'unknown-cell'` ——
  **舱自己声明自己是谁**，审计里的归属因此可以被伪造

对一个「以留痕为卖点」的产品，这两条都不能接受。

**要改成令牌注册表**：

1. 令牌 → 舱 id 的映射，由 broker 持有（内存即可，进程退出即失）
2. 校验是「令牌必须存在**且**其绑定的舱 id 与本次会话一致」
3. **`cellId` 从令牌反查得出，不读请求头** —— 归属不可伪造。
   请求头里的 cell id 只能作为「与令牌不一致就拒绝」的辅助检查
4. 令牌生命周期与舱绑定：起舱时注册，**舱销毁即注销**（这是 I-B6 的落点）
5. 令牌数量上限：超过上限时拒绝起新舱并给出人话错误（防止泄漏的令牌无限堆积在内存里）

**已经满足的部分**：两个监听面、按请求路由、审计按 `cellId` 记 —— 这些都不用改，
缺的只是**令牌与归属**这一层。

### 20.4 默认只提供 osw 作为模型管理

**决定**：默认配置里**只有一个上游：`osw`**。原有的 `anthropic` / `openai` / `dsh`
三个直连上游**不再出现在默认配置里**。

**理由**：默认配置是产品形态的声明。留着三个直连上游，等于宣称「abx 自己也能管供应商」，
而实际上「管理模型和切换」这件事已经交给 OSW 了。**留一个口子就会有人用那个口子**，
而用了直连上游之后就绕过了 OSW 的模型管理与故障转移，产品叙事也就散了。

**保留的能力**：`upstreams` 是配置驱动的一个数组，**加一条直连上游仍然是支持的** ——
自测某个供应商时有用。但它是「你会改配置才会得到的东西」，不是默认。

**与 §16 的关系**：`osw` 上游**不配 `secretEnv`**（OSW 无鉴权），
气闸对它的行为是**剥离**鉴权头而非注入。细节见
[`agent-config.md`](./agent-config.md)。

---

*本文与代码同步维护。改动 `core` 的模块边界或任一不变量时，必须同时更新本文。*
