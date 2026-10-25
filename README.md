<!-- 标志。图是 `pnpm icons` 产出的，**不要手改**；真源是 `packages/console/public/icon.svg`。
     `alt` 是空的：它是装饰，名字由下面那行标题承担（`design-system.md` §5）。 -->
<img src="./apps/docs/assets/brand/png/icon-256.png" alt="" width="96" />

# abx

给 AI coding agent 用的本地隔离沙箱（代号 Airlock）：agent 在容器里干活，
**真实凭据不出宿主**、出口默认拒绝、进出留痕。

> ## ⚠️ 参赛声明：本项目已放弃比赛
>
> 这个仓库是一份**参赛作品**。由于**我个人的时间安排原因**，我没能腾出足够的时间把它做完，
> 所以**退出本次比赛，不再提交参赛**。
>
> 说清楚一点：**不是赛程太短，是我自己的时间排不开。** 这是我这边的问题，跟比赛本身无关。
>
> 需要说明的是：**放弃的是比赛，不是这个项目。** 代码照原来的计划继续写，
> 下面两个站点也照常可访问；进度以 [`apps/docs/roadmap.md`](apps/docs/roadmap.md) 为准，
> 那里逐层记录了「已落地 / 部分 / 未做」，不做美化。
>
> 如果你是因为比赛看到这个仓库的：谢谢关注，也抱歉——它没能完整地站到赛场上。

<!-- 徽章用 shields.io 静态徽章 + 链接到对应 workflow，而不是 GitHub 的实时 status badge：
     本仓库是私有的，而 GitHub 渲染 README 图片走 camo（匿名抓取），私仓的 actions/.../badge.svg
     会拿到 404、显示为裂图（GitHub 文档：“Workflow badges in a private repository are not
     accessible externally”）。仓库转公开后，把这四个换成
     `https://github.com/yinxulai/abx/actions/workflows/<file>/badge.svg?branch=main` 即可。 -->
[![ci.yml](https://img.shields.io/badge/ci.yml-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/yinxulai/abx/actions/workflows/ci.yml)
[![package-macos.yml](https://img.shields.io/badge/package--macos.yml-macOS-000000?logo=apple&logoColor=white)](https://github.com/yinxulai/abx/actions/workflows/package-macos.yml)
[![package-linux.yml](https://img.shields.io/badge/package--linux.yml-Linux-FCC624?logo=linux&logoColor=black)](https://github.com/yinxulai/abx/actions/workflows/package-linux.yml)
[![package-windows.yml](https://img.shields.io/badge/package--windows.yml-Windows-0078D4?logo=windows11&logoColor=white)](https://github.com/yinxulai/abx/actions/workflows/package-windows.yml)

![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![pnpm 12.14.0](https://img.shields.io/badge/pnpm-12.14.0-f69220?logo=pnpm&logoColor=white)

## 它做什么，不做什么

**它做什么**

- 让 agent 在容器（「舱」）里干活，宿主只留调度、凭据与审计。
- **凭据不出舱**：舱内只有一个会被无条件替换的占位符，拿到它也没有用处。
- **默认拒绝**：白名单外的出网一律 403 并留痕；共享的文件与目录默认只读，绝不动原文件。

**它明确不做什么**（把边界说清楚，比说漂亮重要）

- 不是虚拟机：共用宿主内核，**不承诺防住内核级逃逸**。
- 不承诺网络侧匿名：出网 IP 仍然是你自己的。
- 不挡你**主动**把密钥拖进共享区——那是你的操作，不是它可以拦住的事。
- 不是跨平台产品：V1 只面向 macOS；Linux 只服务开发，**没有 Linux / Windows 桌面版**。
- 没有命令行入口；也不做账号、团队、云同步与遥测。
- 目前没有公开发布的安装包；自行打包的产物是 ad-hoc 签名、未公证。

完整清单与未验证项见手册的[「明确不做的边界」](https://abx-docs.yinxulai.workers.dev/limits/limitations/)。

## 官网与文档

| | 地址 |
| --- | --- |
| **官网** —— 它是什么、怎么用、明确不承诺什么 | <https://abx-www.yinxulai.workers.dev> |
| **使用手册** —— 按读者的问题分五个 tab | <https://abx-docs.yinxulai.workers.dev> |

两个站点都部署在 Cloudflare，形状是 **Worker + 静态资源**，不是经典 Pages 项目——
所以部署命令是 `npx wrangler deploy`（配 `[assets]`），而不是 `wrangler pages deploy`
（配 `pages_build_output_dir`）。写混了不会在构建期报错，只在部署时失败，且报错读起来
像文件找不到。配置在各目录的 `wrangler.toml`，顶部注释写了这个坑。

官网在**构建期预渲染首屏**，所以关掉 JavaScript 也能读到正文；手册是逐页静态 HTML。

仓库内的文档入口：[`apps/docs/specs/README.md`](apps/docs/specs/README.md)（规格地图）、
[`apps/docs/roadmap.md`](apps/docs/roadmap.md)（进度）、[`AGENTS.md`](AGENTS.md)（仓库纪律）。

## 快速开始

**环境要求**

- Node.js >= 24（根 `package.json` 的 `engines` 字段是唯一权威）
- pnpm（版本由根 `package.json` 的 `packageManager` 字段决定，`pnpm@12.14.0`）

**开发命令**（提交前这四条都要是绿的）

```bash
pnpm install        # 安装依赖；prepare 顺带装好 git 钩子与提交模版
pnpm lint           # ESLint + 包边界 + agent 清单 + 版本一致性
pnpm typecheck      # tsc 一次覆盖全部包的源码树
pnpm test           # vitest
```

`pnpm test:coverage` 在跑测试之外收集覆盖率；`pnpm build` 由 turbo 按包依赖顺序构建全部包。
托盘应用怎么起来、各平台链路怎么走，见
[`apps/docs/specs/overview/platforms.md`](apps/docs/specs/overview/platforms.md)。

## 仓库结构

组织方式与 osw 一致：`packages/*` 放**库**，`apps/*` 放**入口程序**。

<details>
<summary>目录树</summary>

```
abx/
├── apps/
│   ├── app/                # @abx/app —— Electron 托盘应用（唯一的人机界面）
│   ├── www/                # @abx/www —— 官网
│   └── docs/               # @abx/docs —— 使用手册
├── packages/
│   ├── contracts/          # @abx/contracts —— 类型 + zod schema，唯一真相
│   ├── core/               # @abx/core —— broker / policy / session / transom / commands
│   ├── console/            # @abx/console —— 托盘面板（React）
│   └── toolkit/            # @abx/toolkit —— 工具链，不含任何运行时代码
│       ├── scripts/        # lint / typecheck / test / version / 包边界校验 / 端到端
│       ├── tsconfig.check.json
│       └── vitest.config.ts
├── images/
│   └── agents/             # 每个 agent 一个目录：Dockerfile + README
├── scripts/
│   └── generate-icons.mjs  # `pnpm icons` 的出处
├── .github/
│   ├── actions/setup/      # CI 共用的 Node + pnpm 安装步骤
│   └── workflows/          # ci.yml + 各平台打包
├── abx.config.json         # 气闸默认配置（不含任何明文密钥）
├── AGENTS.md
├── README.md
├── eslint.config.js
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json           # 各包 extends 的根配置
└── turbo.json
```

</details>

职责：

| 目录 | 职责 |
| --- | --- |
| `packages/contracts` | 共享契约：跨包共用的类型与 zod schema。只描述形状，不依赖任何实现。 |
| `packages/core` | 领域逻辑。broker / policy / session / transom 已作为本包的内部模块落地；纯 Node，不含宿主依赖。 |
| `packages/console` | 面板 UI（React），只跟宿主给的 bridge 说话；浏览器里也能单独打开。 |
| `packages/toolkit` | 跨包的开发脚本与静态守卫（lint / typecheck / test / version / 包边界）。 |
| `apps/app` | 托盘应用宿主：系统托盘、面板窗口、拖放与会话 IPC。 |
| `apps/www` / `apps/docs` | 两个静态站（官网 / 手册），产物部署到 Cloudflare。 |
| `images/agents` | agent 镜像定义，一个 agent 一个目录。 |

边界由 [`packages/toolkit/scripts/check-package-boundaries.mjs`](packages/toolkit/scripts/check-package-boundaries.mjs)
守着：`packages/*` 不得依赖 `apps/*`。

## 进度

**进度以 [`apps/docs/roadmap.md`](apps/docs/roadmap.md) 为唯一来源**，那里逐层记录
「已落地 / 部分 / 未做」。这里只给一句口径，且刻意不铺开——README 抄一份进度，
迟早会和那份表说的不一样。

当前：docker 后端的会话编排、共享目录（文件与目录、只读、四道闸）、agent 清单与镜像
（`claude` / `codex`）、出口默认拒绝与审计、传递窗（舱内 `publish` / `open` 两个工具），
以及五个端到端脚本（`e2e-local` / `e2e-docker` / `e2e-shared` / `e2e-persist` / `e2e-transom`；
另有需要真凭据、只在开发机手跑的 `e2e-agent-claude`）都已落地并有测试。
`dsh` 的镜像尚未构建，所以那个 agent 现在打不开——面板会直接告诉你原因。

## 技术选型

选型与 **osw 完全对齐**（版本范围逐条取自 osw 的 `package.json`，不自己挑版本）：

| 领域 | 选型 |
| --- | --- |
| 工作区 | pnpm workspace（`pnpm@12.14.0`，`packages/*` + `apps/*`） |
| 语言 | TypeScript（`@typescript/typescript6`）+ Node >= 24 |
| 任务编排 | turbo 2 |
| 静态检查 | eslint 10 + `@yinxulai/eslint-plugin-peculiar` |
| 测试 | vitest 5（`@vitest/coverage-v8`），组件测试用 jsdom + Testing Library |
| 前端 | React 19 + Vite 8（`@vitejs/plugin-react`） |
| 校验 | zod 4（`@abx/contracts` 的依赖） |

**目的：将来 abx 与 osw 可以合并为一个应用。** 两边目录语义对位（`contracts` / `core` /
`console` / `toolkit` + `apps/*`）、技术栈同版本，合并时不需要先做一轮「统一依赖版本」的迁移。

前端与测试工具链（Vite / jsdom / Testing Library 等）**统一落在根 `devDependencies`**，
版本只有一个来源；`@abx/console` 的面板已落地并复用这些版本。

electron 已引入（`apps/app`）；其余尚未引入的具体产品库见 [`AGENTS.md`](AGENTS.md) 的
「暂缓未加依赖」一节。

## 参与

- 提交信息用**英文**，套 [`.gitmessage`](.gitmessage) 模版：`<type>(<scope>): <summary>`
  （72 字符内、祈使句、小写），空行之后是 `Why:` / `What:` / `Verify:` 三段。
- [`.githooks/commit-msg`](.githooks/commit-msg) 会拒绝不合规的信息（格式错、缺段、出现中文都会被拒）。
  手动校验一条现成信息：`pnpm commit:check .git/COMMIT_EDITMSG`。
- 一次提交只做一件逻辑上的事；提交前 `pnpm lint` / `pnpm typecheck` / `pnpm test` 都要绿。
- 新增依赖前先确认 `/home/openclaw/Project/osw` 里有没有对应物，同版本优先；细节见
  [`AGENTS.md`](AGENTS.md) 的「依赖选型」。
- 文档「**一个主题只在一处展开**」：其它地方只写结论加链接，不复述。

## 许可与使用

本仓库是**私有仓库**：`package.json` 里 `"private": true`、`"license": "UNLICENSED"`，
**未授予任何使用、复制或分发许可**，仅供作者本人与获授权者使用。

仓库内不出现任何明文密钥——凭据只以环境变量名或文件路径的形式引用（见 [`AGENTS.md`](AGENTS.md) 的「密钥」一节）。
