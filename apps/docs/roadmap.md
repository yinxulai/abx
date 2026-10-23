# abx 路线图

**本文是进度与验收状态的唯一来源。** 其它文档不写「做到了哪一步」，
只写设计与取舍。

最后更新：2026-10-23。

---

## 一、当前状态

| 层 | 状态 |
|---|---|
| 规格文档 | ✅ 已就位（`specs/`） |
| `packages/contracts` | ✅ 已落地（13 文件 / 2 测试文件） |
| `packages/core`（broker / policy / session / commands） | ✅ 已落地（38 文件 / 14 测试文件） |
| 气闸的舱身份（单实例多舱） | ✅ 已落地（令牌注册表，cellId 由令牌反查、不可伪造） |
| `packages/console`（React 面板） | 🟡 基础面板已落地：状态块 / 高度回报 / 拖放区 / 共享列表（渲染宿主快照、目录与文件两种符号、被拒条目的原因行），jsdom 测试通过；**已在无头 Linux 上渲染并截图**，明暗两套对比度实测达标（见 [`overview/platforms.md`](./overview/platforms.md) §2） |
| `apps/app`（Electron 托盘） | 🟡 骨架 + 面板加载 + 拖放 IPC + 共享列表 IPC（`shared:list` / `shared:add`）；**已能在无头 Linux（Xvfb）上起来、渲染并截图**；托盘锚点定位仍未验证 |
| agent 清单（镜像 / 持久化目录 / 图标 / 配置模板） | ✅ 已落地（**加一个 agent = 一条数据**；构建期拒绝空的、`latest` 的镜像版本，并有守卫禁止别处再声明 agent）；镜像按 agent id 构建（`build-agent-image.sh <agent-id>`），**codex 已构建、dsh 仍未构建**——镜像没构建时 `abx open <agent>` 在起容器之前就停下来说清该跑哪条命令 |
| `packages/core/session` 的挂载与 agent 配置生成 | ✅ 已落地（生成最小配置、单文件只读挂载、凭据文件黑名单） |
| 共享给全部 agent（文件 / 目录，只读） | ✅ 已落地（契约 / 解析四道闸 / `~/.abx/shared.json` 持久化 / 面板列表 / 宿主 IPC；真 docker 验证见 `../packages/toolkit/scripts/e2e-shared.sh`）；**会话接线未做** |
| 配置层（zod schema 为唯一真相） | ✅ 已落地（类型从 schema 推导；手写 readers 已删除） |
| 舱面来源网段校验 | ✅ 已落地（来源网段判定在令牌解析**之前**、令牌加可扫描前缀、审计记来源地址；实测结论：回环必须进默认放行名单，同机进程仅靠令牌挡住） |
| `apps/www`（官网） | ✅ 已上线 <https://abx-www.yinxulai.workers.dev>（凭据叙事、三步用法、安全边界、明确不承诺项）；构建期预渲染首屏，**关掉 JS 也能取到正文**（55 KB / 3.7k 中文字） |
| 本地（local 后端）端到端脚本 | ✅ 已落地（改走 core 命令层，30 条断言实测通过）；**`local` 不是沙箱，只为开发自测存在，永不默认、永不回退** |
| 后端选择策略（docker 优先 + 留扩展口子） | ✅ 已落地（支持的 id 只在契约里声明一次；工厂是一张 `Record<SandboxBackendId, …>` 映射表，加 id 不加实现**编译不过**；未知 id 响亮失败、绝不回退到 local；见 [`overview/architecture.md`](./overview/architecture.md) §7.2）。**没有任何新后端**：podman / bwrap 都只是口子 |
| macOS 打包与 CI | ✅ 已落地（electron-builder + macOS workflow）；**未在真机打过包** |
| Linux 开发链路 | ✅ 已落地（按平台分叉 + `verify:linux` 无头验证入口，见 [`overview/platforms.md`](./overview/platforms.md)）；Linux 只服务开发，不是发布平台 |
| Linux 打包与 CI | 🟡 AppImage 与 deb 都在本机打出来了，deb 解包后的可执行文件也能起；**CI 流水线尚未在 runner 上跑过，deb 也从未装过** |
| `apps/docs`（文档站） | ✅ 已上线 <https://abx-docs.yinxulai.workers.dev>（33 页，中文为源语言、英文增量补译，机器审计校验与清单一致）；**英文侧 10 页仍回退中文** |

**当前基线：** `pnpm lint` / `pnpm typecheck` / `pnpm test` 三样全绿，**729 个测试**（53 个文件）。

> 上表里「airlock 阶段」指本项目在 `/home/openclaw/Project/airlock` 下完成的第一次实现。
> 那个目录是**早期的错误落点**，代码已按
> [`overview/architecture.md`](./overview/architecture.md) §1 的映射搬入本仓库，
> 它不再是任何东西的正式来源。

---

## 二、已实测验证的（有真实输出）

在 Linux + Docker Desktop 上验过，逐条见
[`overview/architecture.md`](./overview/architecture.md) §19。

**隔离性质（九条）**

非 root · 无 sudo · 根文件系统只读 · `/tmp` 可写 · 无 docker socket ·
任务目录可挂 · 环境变量无真密钥 · 退出即销毁 · 舱内可达宿主 broker

**代理行为**

白名单命中放行 / 未命中 403 并留痕 · 占位符被真实密钥替换 · 审计不写入密钥值

**共享挂载（六条，`e2e-shared.sh`，真容器真 argv）**

整挂的目录舱内读得到且**逐字节一致**（两侧 sha256 相同）· 共享区只读而任务目录仍可写 ·
装着 `.env` 的目录被拒（理由点名 `.env`）且**一次 `docker run` 都没有** ·
软链按解析后的目标判定（指向 `$HOME` 与指向共享目录之外的 `.env` 都被拒）·
重名排到 `/shared/notes-2`，两个都在且内容各是各的 ·
**挂载清单算好之后**新增的文件立刻可见（整目录绑定，不是快照）

---

## 三、⚠️ 实测推翻的两个假设（已写进设计）

1. **`172.17.0.1` 在 Docker Desktop 上不可用** —— 宿主绑不上、舱内连不上。
   abx 只做 macOS，而 macOS 只有 Docker Desktop，所以原默认值 100% 起不来。
   改为绑 `0.0.0.0` + 舱内用 `host.docker.internal` + 来源网段校验补偿。
2. **挂载源必须在 Docker Desktop 共享路径内** —— 否则 `mounts denied`，容器起不来。
3. **禁挂前缀名单挡不住软链** —— 名单写的是 `/var/run`，而在相当多的系统上它就是
   `/run` 的软链：判 realpath 之后一个前缀都对不上，「docker socket 的父目录不许挂」
   这条闸门形同不存在。macOS 上还有同一类的第二个：那边 `/etc` `/var` 都指向
   `/private/...`。修法是**字面路径与解析后的路径两道都判**，并给共享源补上
   `/run` 与 `/private/...` 这几条（见 `packages/core/source/session/shared.ts`）。

---

## 四、明确未验证的（不许当已通过）

| 项 | 为什么没验 |
|---|---|
| **macOS 真机** | 以上全部在 Linux 版 Docker Desktop 上测的；macOS 的共享路径默认值与 VM 网关地址可能不同，**必须重跑** |
| **真实 agent 二进制** | 舱内跑的一直是替身脚本，不是真的 Claude Code / Codex |
| **真实 agent 的出网域名集合** | `egress.allow` 默认拒绝；若 agent 还会连别的域名，用户会看到「气闸一开就不好用」。白名单大概率要补，补哪几条只能靠实测 |
| **`ANTHROPIC_CUSTOM_HEADERS` 多行格式** | 按 `Name: Value` 换行分隔实现，是**推断**，没对着文档或真实行为核实 |
| **`codex` / `dsh` 的定义** | `codex` 的登录态走另一套机制；`dsh` 命令名与变量名**三样都无权威来源**，标为 `unconfirmed` |
| **对抗性测试** | 没有任何一步尝试绕过白名单、伪造舱令牌、从舱内往外打。现有证据都是「正常用的时候它是对的」 |
| **托盘锚点定位与托盘拖拽** | Electron 本身已能在 Xvfb 上跑（面板已渲染并截图），但 Xvfb 里**没有托盘宿主**：`Tray.getBounds()` 没有可信值，`drop-files` 又是 macOS only。两条都只能在 macOS 真机上验 |
| **共享链路在 macOS 上** | `e2e-shared.sh` 是在 Linux 上跑的：macOS 的共享路径默认值、uid 映射与 `/private/...` 软链都不同，**必须重跑**；面板那一半（拖放、即时预览）根本没在真机上点过 |

---

## 五、阶段

### 阶段 0 · 能力层（进行中）

- [x] 规格文档
- [x] 把 core 模块搬入本仓库并归位（contracts / core）
- [ ] 补齐 §19 的两处修正（舱面地址探测、共享路径检查）
- [ ] `core/session` 的挂载与 agent 配置生成（并行作业 C）
- [x] 桌面壳骨架：原生 Tray 图标 + 自绘面板窗口 + IPC 上报高度
- [x] 共享给全部 agent：条目 → 只读挂载 → 面板列表 → 宿主持久化（规格 [`product/shared-mounts.md`](./product/shared-mounts.md)）
- [ ] 共享列表接进 `session.create`：起容器那一刻重算一遍（加进来时干净，不代表起容器时还干净）
- [ ] `console` 面板：按 [`product/tray-ui.md`](./product/tray-ui.md) 实现（并行作业 D）

**阶段 0 的验收标准**：主分支上 `pnpm lint` / `pnpm typecheck` / `pnpm test` 三样全绿，
且 `pnpm build` 能产出可运行产物；面板在浏览器（jsdom）里能渲染并通过视觉评审。

> 原标准里写的 `apps/dev-cli` 已删除 —— 编排逻辑收在 `packages/core/source/commands/`，
> 由 `apps/app` 主进程调用。

### 阶段 1 · 文件闸口

- [ ] 三个口（work / inbox / outbox）完整语义
- [ ] 出舱审核作为**事务日志**而非拦截器
- [ ] 挂载时 realpath 校验（防符号链接与硬链接逃逸）

### 阶段 2 · 体验层完成

- [ ] 面板的状态灯、产出通知、审计可视化
- [ ] 明暗跟随系统
- [ ] 首次启动引导（不填密钥就能看到界面）

### 阶段 3 · 接入 OSW

- [ ] 气闸的唯一下游改为 OSW 的本地地址
- [ ] 气闸自带的直连上游降级为开发期能力
- [ ] 评估与 OSW 合并为一个应用

---

## 六、下一个动作

**补上 macOS 真机验证。** 这是唯一一条「所有结论都建立在别的平台上」的风险 ——
而 macOS 恰恰是 V1 唯一的目标平台。在它被验之前，任何「已经能用」的说法都是虚的。
