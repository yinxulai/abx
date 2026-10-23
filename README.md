# abx

给 AI coding agent 用的本地隔离沙箱（代号 Airlock）。

## 当前状态

**只有基础框架，产品逻辑尚未实现。**

仓库里现在能跑通的是一条完整的工具链：依赖安装、静态检查、类型检查、测试。
沙箱本身（隔离、代理、进程管控）一行都还没写。

## 目录结构

组织方式与 osw 一致：`packages/*` 放**库**，`apps/*` 放**入口程序**。

```
abx/
├── apps/
│   └── cli/                # @abx/cli —— 命令行入口（占位，尚未实现）
├── packages/
│   ├── contracts/          # @abx/contracts —— 类型 + zod schema
│   ├── core/               # @abx/core —— 领域逻辑（占位）
│   ├── console/            # @abx/console —— Web UI（占位）
│   └── toolkit/            # @abx/toolkit —— 工具链，不含任何运行时代码
│       ├── scripts/        # lint / typecheck / test / version / 包边界校验
│       ├── tsconfig.check.json
│       └── vitest.config.ts
├── .github/
│   ├── actions/setup/      # CI 共用的 Node + pnpm 安装步骤
│   └── workflows/ci.yml    # typecheck / lint / test / build
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
| `packages/console` | Web 控制台，将来构建为纯静态产物，只通过管理 API 与核心通信。 |
| `packages/toolkit` | 跨包的开发脚本与静态守卫（lint / typecheck / test / version / 包边界）。 |
| `apps/cli` | 命令行宿主：参数解析与宿主适配，把核心能力跑成前台进程。 |

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

尚未引入的具体产品库（electron、drizzle、CodeMirror、Radix 等）见 `AGENTS.md` 的「暂缓未加依赖」一节。
