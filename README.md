# abx

给 AI coding agent 用的本地隔离沙箱（代号 Airlock）。

## 当前状态

**只有基础框架，产品逻辑尚未实现。**

仓库里现在能跑通的是一条完整的工具链：依赖安装、静态检查、类型检查、测试。
沙箱本身（隔离、代理、进程管控）一行都还没写。

## 目录结构

```
.
├── packages/
│   ├── contracts/          # 共享契约：跨包共用的类型与常量
│   └── toolkit/            # 开发脚本与静态守卫，不含任何运行时代码
│       ├── scripts/        # lint / typecheck / test / version / 包边界校验
│       ├── tsconfig.check.json
│       └── vitest.config.ts
├── .github/
│   ├── actions/setup/      # CI 共用的 Node + pnpm 安装步骤
│   └── workflows/ci.yml    # typecheck / lint / test / build
├── eslint.config.js
├── tsconfig.json           # 各包 extends 的根配置
├── tsconfig.base.json
├── turbo.json
└── pnpm-workspace.yaml
```

`packages/*` 放能力包，`apps/*` 放宿主程序（目前为空）。

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
