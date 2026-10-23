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
| `packages/core/session` 的挂载与 agent 配置生成 | 🚧 进行中（并行作业 C） |
| `packages/console`（React 面板） | 🚧 进行中（并行作业 D） |
| `apps/app`（Electron 托盘） | 🚧 骨架已提交，面板与拖放进行中（并行作业 D） |
| `apps/www`（官网） | 🚧 进行中（并行作业 E） |
| macOS 打包与 CI | 🚧 进行中（并行作业 F） |
| `apps/docs`（文档站） | ⬜ 未建站，仅有 Markdown |

**当前基线（`9067355`）：** `pnpm lint` / `pnpm typecheck` / `pnpm test` 三样全绿，293 个测试。

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

---

## 三、⚠️ 实测推翻的两个假设（已写进设计）

1. **`172.17.0.1` 在 Docker Desktop 上不可用** —— 宿主绑不上、舱内连不上。
   abx 只做 macOS，而 macOS 只有 Docker Desktop，所以原默认值 100% 起不来。
   改为绑 `0.0.0.0` + 舱内用 `host.docker.internal` + 来源网段校验补偿。
2. **挂载源必须在 Docker Desktop 共享路径内** —— 否则 `mounts denied`，容器起不来。

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
| **Electron / 托盘拖拽** | 开发机 `DISPLAY` 为空，Electron 跑不起来；`drop-files` 是 macOS only |

---

## 五、阶段

### 阶段 0 · 能力层（进行中）

- [x] 规格文档
- [x] 把 core 模块搬入本仓库并归位（contracts / core）
- [ ] 补齐 §19 的两处修正（舱面地址探测、共享路径检查）
- [ ] `core/session` 的挂载与 agent 配置生成（并行作业 C）
- [x] 桌面壳骨架：原生 Tray 图标 + 自绘面板窗口 + IPC 上报高度
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
