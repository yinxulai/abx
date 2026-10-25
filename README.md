<!-- 标志。图是 `pnpm icons` 产出的，**不要手改**；真源是 `packages/console/public/icon.svg`。
     `alt` 是空的：它是装饰，名字由下面那行标题承担（`design-system.md` §5）。 -->
<img src="./apps/docs/assets/brand/png/icon-256.png" alt="" width="96" />

# abx

给 AI coding agent 用的本地隔离沙箱（代号 Airlock）。

> ## ⚠️ 参赛声明：本项目已放弃比赛
>
> 这个仓库是一份**参赛作品**。由于**时间原因**，我没能在赛程内把它做完，
> 所以**退出本次比赛，不再提交参赛**。
>
> 需要说清楚的是：**放弃的是比赛，不是这个项目。** 代码照原来的计划继续写，
> 下面两个站点也照常可访问；进度以 [`apps/docs/roadmap.md`](apps/docs/roadmap.md) 为准，
> 那里逐层记录了「已落地 / 部分 / 未做」，不做美化。
>
> 如果你是因为比赛看到这个仓库的：谢谢关注，也抱歉——它没能完整地站到赛场上。

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

## 当前状态

**进度以 [`apps/docs/roadmap.md`](apps/docs/roadmap.md) 为唯一来源**，那里逐层记录
「已落地 / 部分 / 未做」。这里只给一句口径，且刻意不铺开——README 抄一份进度，
迟早会和那份表说的不一样。

当前：docker 后端的会话编排、共享目录（文件与目录、只读、四道闸）、agent 清单与镜像
（`claude` / `codex`）、出口默认拒绝与审计、以及本地与容器两套端到端脚本都已落地并有测试。
`dsh` 的镜像尚未构建，所以那个 agent 现在打不开——面板会直接告诉你原因。

## 目录结构

组织方式与 osw 一致：`packages/*` 放**库**，`apps/*` 放**入口程序**。

```
abx/
├── apps/
│   ├── app/                # @abx/app —— Electron 托盘应用（唯一的人机界面）
│   ├── www/                # @abx/www —— 官网
│   └── docs/               # @abx/docs —— 使用手册
├── packages/
│   ├── contracts/          # @abx/contracts —— 类型 + zod schema，唯一真相
│   ├── core/               # @abx/core —— broker / policy / session / commands
│   ├── console/            # @abx/console —— 托盘面板与管理面板（React）
│   └── toolkit/            # @abx/toolkit —— 工具链，不含任何运行时代码
│       ├── scripts/        # lint / typecheck / test / version / 包边界校验 / 端到端
│       ├── tsconfig.check.json
│       └── vitest.config.ts
├── images/
│   └── agents/             # 每个 agent 一个目录：Dockerfile + README
├── .github/
│   ├── actions/setup/      # CI 共用的 Node + pnpm 安装步骤
│   └── workflows/          # ci.yml + 各平台打包
├── AGENTS.md
├── README.md
├── eslint.config.js
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json           # 各包 extends 的根配置
└── turbo.json
```

职责：

| 目录 | 职责 |
| --- | --- |
| `packages/contracts` | 共享契约：跨包共用的类型与 zod schema。只描述形状，不依赖任何实现。 |
| `packages/core` | 领域逻辑。broker / policy / session 将来作为本包的内部模块；纯 Node，不含宿主依赖。 |
| `packages/console` | 面板 UI（React），只跟宿主给的 bridge 说话；浏览器里也能单独打开。 |
| `packages/toolkit` | 跨包的开发脚本与静态守卫（lint / typecheck / test / version / 包边界）。 |
| `apps/app` | 托盘应用宿主：系统托盘、面板窗口、拖放与会话 IPC。 |
| `apps/www` / `apps/docs` | 两个静态站（官网 / 手册），产物部署到 Cloudflare。 |
| `images/agents` | agent 镜像定义，一个 agent 一个目录。 |

边界由 `packages/toolkit/scripts/check-package-boundaries.mjs` 守着：`packages/*` 不得依赖 `apps/*`。

## 开发命令

```bash
pnpm install       # 安装依赖
pnpm lint          # ESLint + 包边界校验 + 版本一致性
pnpm typecheck     # tsc 覆盖全部包的源码树
pnpm test          # vitest
pnpm test:coverage # 同上，并收集覆盖率
```

## 环境要求

- Node.js >= 22
- pnpm（版本由根 `package.json` 的 `packageManager` 字段决定）

## 技术选型

选型与 **osw 完全对齐**（版本范围逐条取自 osw 的 `package.json`，不自己挑版本）：

| 领域 | 选型 |
| --- | --- |
| 工作区 | pnpm workspace（`pnpm@12.14.0`，`packages/*` + `apps/*`） |
| 语言 | TypeScript（`@typescript/typescript6`）+ Node >= 22 |
| 任务编排 | turbo 2 |
| 静态检查 | eslint 10 + `@yinxulai/eslint-plugin-peculiar` |
| 测试 | vitest 5（`@vitest/coverage-v8`），组件测试用 jsdom + Testing Library |
| 前端 | React 19 + Vite 8（`@vitejs/plugin-react`） |
| 校验 | zod 4（`@abx/contracts` 的依赖） |

**目的：将来 abx 与 osw 可以合并为一个应用。** 两边目录语义对位（`contracts` / `core` / `console` / `toolkit` + `apps/*`）、技术栈同版本，合并时不需要先做一轮「统一依赖版本」的迁移。

前端与测试栈（React / Vite / jsdom 等）**先落在根 `devDependencies`**，`@abx/console` 本阶段只是占位、不搭应用；这样版本只有一个来源，将来 console 真正开工时不必再谈一次。

electron 已引入（`apps/app`）；其余尚未引入的具体产品库见 `AGENTS.md` 的「暂缓未加依赖」一节。
