# AGENTS.md

## 工具链

- 包管理器只用 **pnpm**，不要用 npm / yarn，也不要手改 `pnpm-lock.yaml`。
- 常用命令：`pnpm install` / `pnpm lint` / `pnpm typecheck` / `pnpm test`。
  提交前这四条都要是绿的。

## 提交

- 提交信息用英文，格式 `type(scope): summary`，例如 `feat(sandbox): add process isolation`。
- git 身份：`AlainClaw <yinxulai@hotmail.com>`。

## 密钥

- **仓库内绝不出现任何明文密钥**：token、密码、私钥、连接串一律不进仓库。
- 配置里只写环境变量名（如 `ABX_API_TOKEN`），真实值留在本地文件或 CI secret 里。
- `.env` 系列文件已在 `.gitignore` 中，需要样例时提交 `.env.example` 并只填占位符。

## 代码约定

- `packages/toolkit/` 里的脚本是工具链本身，**除非必要不要改动其逻辑**；
  需要新增检查项时优先加在配置或新脚本里，而不是改写现有脚本的语义。
- 包之间的依赖方向由 `packages/toolkit/scripts/check-package-boundaries.mjs` 守着：
  `packages/*` 不得依赖 `apps/*`，跨包引用必须在 `package.json` 里声明依赖。
- 新增包时同步更新 `packages/<name>/package.json`、`tsconfig.json`，版本号与根保持一致
  （`pnpm version:set <version>` 会把根版本刷到每一个包）。
