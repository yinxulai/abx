# abx 路线图

**本文是进度与验收状态的唯一来源。** 其它文档不写「做到了哪一步」，
只写设计与取舍。

最后更新：2026-10-23。

---

## 一、当前状态

| 层 | 状态 |
|---|---|
| 规格文档 | ✅ 已就位（`specs/`） |
| `packages/contracts` | ⏳ 待落地（airlock 阶段已有 12 文件 / 1663 行，未搬入） |
| `packages/core`（broker / policy / session） | ⏳ 待落地（airlock 阶段已有 29 文件 / 4880 行、310 测试全绿，未搬入） |
| `packages/core/mounts`（共享区与文件闸口） | ⬜ 未开始 |
| `packages/console`（React 面板） | 🟡 基础面板：状态块 / 高度回报 / 拖放区，jsdom 测试通过；真机未看 |
| `apps/app`（Electron 托盘） | 🟡 骨架 + 面板加载 + 拖放 IPC；Electron 未在真机验证 |
| `apps/docs`（文档站） | ⬜ 未建站，仅有 Markdown |

> 上表里「airlock 阶段」指本项目在 `/home/openclaw/Project/airlock` 下完成的第一次实现。
> 那个目录是**早期的错误落点**，代码将按
> [`overview/architecture.md`](./overview/architecture.md) §1 的映射搬入本仓库，
> 之后它不再是任何东西的正式来源。

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
- [ ] 把 core 模块搬入本仓库并归位（contracts / core）
- [ ] 补齐 §19 的两处修正（舱面地址探测、共享路径检查）
- [ ] `core/mounts`：共享区、出舱审核、禁区与符号链接校验
- [ ] 桌面壳骨架：原生 Tray 图标 + 自绘面板窗口 + IPC 上报高度
- [ ] `console` 面板：按 [`product/tray-ui.md`](./product/tray-ui.md) 实现

**阶段 0 的验收标准**：在 Linux 上（无 GUI）能通过 `apps/dev-cli` 起一个舱、
灌一个文件、看到审计；面板在浏览器里能渲染并通过视觉评审。

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
