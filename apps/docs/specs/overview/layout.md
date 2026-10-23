# 目录与架构设计（落位规范）

**这份文档的作用**：在开始堆功能之前，把「什么代码放在哪里、谁能依赖谁」定死。
堆功能时最贵的错误不是写错逻辑，是**放错位置** —— 位置错了才发现，返工成本是重写。

**规矩**：新增文件前先在本文件里找到它的位置。找不到位置，说明架构有缺口，
**先补这一节，再写代码**。

---

## 1. 两条组织原则（来自 OSW）

1. **`packages/` 放库，`apps/` 放入口程序。** 库不认识应用，应用认识库。
2. **领域逻辑收在单一 `core` 里**，不按技术层横切成一堆 `xxx-service` 包。
   OSW 的 `core` 有近百个文件、内部再分目录，但对外就是一个包。

第二条尤其重要：把 `broker` 拆成独立包、把 `session` 拆成独立包，看起来「清晰」，
实际结果是**每个包都要声明一遍依赖**，而且跨包改一个类型要动三个 `package.json`。
**模块边界靠目录和 lint 规则守，不靠包边界守。**

## 2. 目标目录

```
abx/
├─ apps/                          ← 入口程序
│  ├─ app/                        @abx/app     Electron 主进程 + preload（接线层）
│  │  ├─ source/main.ts           生命周期：Tray、面板窗口、IPC、编排调用
│  │  ├─ source/preload.ts        contextBridge 暴露的极小 API
│  │  └─ scripts/{dev,build}.mjs
│  ├─ www/                        @abx/www     官网（Vite + React）
│  └─ docs/                       @abx/docs    规格文档（本目录的上级）
│
├─ packages/                      ← 库
│  ├─ contracts/                  @abx/contracts
│  │  │  纯类型 + 配置 schema + 校验。零副作用，零 Node API。
│  │  ├─ config.ts                AbxConfig 类型
│  │  ├─ schema.ts                ⬜ zod schema（配置的唯一真相）
│  │  ├─ load-config.ts           读文件 → 解析 → 校验 → AbxConfig
│  │  ├─ agents.ts                AGENT_DEFINITIONS（agent 注册表 + 配置文件白名单）
│  │  ├─ issues.ts                Issue 收集器（一次报全部问题）
│  │  └─ ...
│  │
│  ├─ core/                       @abx/core
│  │  │  纯 Node，不含任何宿主依赖（无 Electron、无 DOM）。
│  │  ├─ broker/                  气闸本体
│  │  │  ├─ server.ts             两个监听面 + 请求编排
│  │  │  ├─ route.ts              /c/<token>/u/<upstream> 与请求头解析
│  │  │  ├─ token.ts              令牌生成
│  │  │  ├─ registry.ts           ⬜ 令牌注册表（令牌 → 舱 id，单实例多舱）
│  │  │  ├─ target.ts             上游选择 + 域名白名单
│  │  │  ├─ credentials.ts        密钥注入 / 剥离
│  │  │  ├─ forward.ts            转发 + 超时 + 流式
│  │  │  └─ audit.ts              审计落盘
│  │  ├─ policy/                  出口策略（域名匹配、白名单）
│  │  ├─ session/                 舱的生命周期
│  │  │  ├─ backend.ts            后端接口（docker / local）
│  │  │  ├─ docker-backend.ts     Docker 实现
│  │  │  ├─ local-backend.ts      本机实现（**不是沙箱**）
│  │  │  ├─ mount-policy.ts       挂载源校验（黑名单、共享路径）
│  │  │  ├─ agent-config.ts       ⬜ 生成 agent 配置（只读挂载的源）
│  │  │  └─ env.ts                环境变量拼装
│  │  ├─ commands/                可测试的编排（不含 GUI）
│  │  │  ├─ open.ts               起舱
│  │  │  ├─ broker.ts             起气闸
│  │  │  ├─ audit.ts              读审计
│  │  │  ├─ doctor.ts             自检
│  │  │  └─ runtime.ts            配置发现 + 后端解析
│  │  └─ index.ts
│  │
│  ├─ console/                    @abx/console
│  │  │  面板的 React 实现。**只做渲染**，不做决策。
│  │  ├─ App.tsx                  ⬜ 面板根
│  │  ├─ components/              ⬜ 卡片、状态块、拖放区
│  │  ├─ hooks/                   ⬜ useTrayHeight（ResizeObserver 回报高度）
│  │  └─ styles.css               ⬜ 透明底 + gutter
│  │
│  └─ toolkit/                    @abx/toolkit  仓库工具（lint/test/typecheck/边界检查）
│
├─ abx.config.json                仓库根的示例配置（**默认只有 osw 上游**）
└─ pnpm-workspace.yaml
```

⬜ = 还没写，位置已定。

## 3. 依赖方向（唯一允许的方向）

```
apps/app ──→ core ──→ contracts
    │           │
    └───────────┴──→ contracts
apps/www  ──→ contracts（只读类型，允许；也可完全不依赖）
apps/docs ──→ 无依赖
packages/console ──→ contracts（只读类型）
```

**硬规则**（`check-package-boundaries.mjs` 已在检查前两条，第三条待加）：

| 规则 | 内容 | 为什么 |
|---|---|---|
| R2 | `packages/*` **不得** import `apps/*` | 库反向依赖入口 = 库无法复用 |
| 跨包 import 必须声明依赖 | 走包名或相对路径都算 | pnpm 的 node_modules 结构会掩盖漏声明 |
| R7（待加） | `contracts` **不得** import `core` | contracts 是最底层，必须是叶子 |
| R8（待加） | `core` 不得 import `electron` / `react` | 这是「core 能在无 GUI 的 Linux 上测」的前提 |
| R9（待加） | `console` 不得 import `core` | 面板只渲染宿主给的数据，不自己调后端 |

R8 不是洁癖：本机 `DISPLAY` 为空，`core` 一旦摸 Electron，测试就全跑不起来。

## 4. 各包职责的一句话定义

| 包 | 一句话 | 不该做的事 |
|---|---|---|
| `contracts` | 定义「配置长什么样」并校验它 | 读文件、起进程、碰网络 |
| `core` | 定义「气闸和舱怎么运作」 | 碰 GUI、碰 Electron |
| `console` | 定义「面板长什么样」 | 做决策、直接调 core |
| `apps/app` | 把上面三样接起来 + 管窗口生命周期 | 自己实现业务逻辑 |
| `toolkit` | 仓库的检查工具 | 被运行时依赖 |

## 5. 配置的唯一真相在 zod schema

现在 `config.ts` 定类型、`load-config.ts` 手写校验、报错文案散在 `validateXxx` 函数里 ——
**同一条规则写三遍**，加一个字段要同步改三处，漏一处就是「类型允许但校验拒绝」这种鬼故事。

改成：

```
schema.ts (zod)  ──z.infer──→  config.ts (类型，自动生成)
       │
       └──parse + error.issues──→  load-config.ts（映射成 Issue 列表）
```

**类型不再手写**，从 schema 推。**校验不再是第二份实现**，就是 schema 本身。

**必须保留的行为**：一次收集**全部**问题再一起报。zod 默认遇错即抛，
所以要自己遍历 `error.issues` 映射进现有的 `IssueCollector`，不能直接 `parse` 完事。

## 6. 并行作业的分区（互不碰同一文件）

多个作业同时跑时，**唯一会冲突的东西是同一个文件**。按文件划分作业边界：

| 作业 | 独占文件 | 交付物 |
|---|---|---|
| **A. 配置层** | `contracts/source/{schema,config,load-config,config-path,expand-env,issues}.ts` | zod schema + 类型推导 + 全量错误收集 |
| **B. 气闸归属** | `core/source/broker/{registry,server,token,route}.ts` | 令牌注册表、单实例多舱、cellId 不可伪造 |
| **C. 舱与挂载** | `core/source/session/{agent-config,mount-policy,docker-backend,env}.ts`、`contracts/source/agents.ts` | 生成 agent 配置、单文件 ro 挂载、凭据文件黑名单 |
| **D. 面板** | `packages/console/**`、`apps/app/source/{main,preload}.ts` | React 面板 + 高度回报 + 拖放 |
| **E. 官网** | `apps/www/**` | 落地页 |
| **F. 文档** | `apps/docs/**` | 规格同步 |

**冲突点**：`contracts/source/agents.ts` 被 C 独占，但 A 也可能想动它 ——
**A 不动它**，A 只动 schema 与加载。`broker/server.ts` 被 B 独占，C 不动 broker。

### 6.1 当前并行作业（2026-10-23）

每个作业一个 git worktree，互不共享工作区，各自 `pnpm install`：

| 作业 | worktree | 分支 | 独占面 |
|---|---|---|---|
| A 配置层 | `/home/openclaw/Project/abx-wt/a-config` | `lane/a-config` | contracts 的 schema/config/load-config/readers |
| B 气闸归属 | `/home/openclaw/Project/abx-wt/b-broker` | `lane/b-broker` | core/broker 的 registry/server/token/route |
| C 舱与挂载 | `/home/openclaw/Project/abx-wt/c-session` | `lane/c-session` | core/session + contracts/agents.ts |
| D 面板 | `/home/openclaw/Project/abx-wt/d-panel` | `lane/d-panel` | packages/console + apps/app 的 main/preload |

**合并顺序**：A → B → C → D。先合 A 是因为它改的是被所有人依赖的配置模型；
后三个与它的接触面分别是「读类型」「不接触」「不接触」。

**基线**：四个分支都从 `9067355` 出发，那个提交上 `lint` / `typecheck` / `test` 三样全绿
（293 个测试）。每个作业**自己那一步全绿才准提交**，合并时我在主分支上复跑整个门序列。

`abx.config.json`、`packages/*/package.json`、`pnpm-lock.yaml` 是**共享文件**：
谁先动谁提交，后来的人 rebase。为减少冲突，**依赖变更集中在 A**（它要加 zod 的用法），
其余作业**不新增依赖**。

## 7. 每次都跑的检查

```
pnpm lint        26 个错误待清零（peculiar 两条规则：签名单行、参数不内联对象类型）
pnpm typecheck   @abx/contracts 解析 + 残留 .ts 后缀
pnpm test
pnpm boundaries  包边界（R2 + 依赖声明）
```

**每步全绿再提交。** 不是「最后一起绿」——最后一起绿等于最后一起崩。

## 8. 待办缺口清单

- [ ] `contracts/schema.ts`：zod schema（A）
- [ ] `core/broker/registry.ts`：令牌注册表（B）
- [ ] `core/session/agent-config.ts`：生成 agent 配置（C）
- [ ] `packages/console/source/App.tsx` 及组件（D）
- [ ] 默认配置只留 `osw` 上游（A，改 `abx.config.json` + 默认值）
- [ ] R7/R8/R9 三条边界规则加进检查脚本（F 或 A）
- [ ] `runtime.ts:77` 的 `entryPath` 指向已删除的 CLI 入口 → 改同进程调用 broker
