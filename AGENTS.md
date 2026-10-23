# AGENTS.md

## 工具链

- 包管理器只用 **pnpm**，不要用 npm / yarn，也不要手改 `pnpm-lock.yaml`。
- 常用命令：`pnpm install` / `pnpm lint` / `pnpm typecheck` / `pnpm test`。
  提交前这四条都要是绿的。

## 提交纪律（强制）

**每一个可验证的小步 = 一次提交。** 不要攒成一个大提交，也不要「全改完再一起提」。

- 一次提交只做**一件逻辑上的事**：加一个模块、改一处行为、补一组测试，各算一步。
- 提交前跑过被改到的检查：`pnpm lint` / `pnpm typecheck` / `pnpm test`。
- 提交信息用**英文**，套用 `.gitmessage` 模版：

  ```
  <type>(<scope>): <summary>

  Why:
    <为什么需要这个改动>

  What:
    - <改了什么>

  Verify:
    - <命令> -> <真实结果>
  ```

  类型限：`feat` / `fix` / `refactor` / `perf` / `test` / `docs` / `build` / `ci` / `chore` / `style` / `revert`。

- 模版是**强制**的：`pnpm install` 时 `prepare` 会把 `core.hooksPath` 指向 `.githooks/`，
  `commit-msg` 钩子会拒绝不合规的信息（subject 格式错、缺 `Why:`/`What:`、出现中文）。
- 手动校验一条现成信息：`pnpm commit:check .git/COMMIT_EDITMSG`
- 临时绕过：`git commit --no-verify` —— 只用于紧急情况，**不要**用它绕过「英文 + 模版」。
- git 身份：`AlainClaw <yinxulai@hotmail.com>`。

## 密钥

- **仓库内绝不出现任何明文密钥**：token、密码、私钥、连接串一律不进仓库。
- 配置里只写环境变量名（如 `ABX_API_TOKEN`），真实值留在本地文件或 CI secret 里。
- `.env` 系列文件已在 `.gitignore` 中，需要样例时提交 `.env.example` 并只填占位符。

## 依赖选型

- **新增任何依赖前，先确认 `/home/openclaw/Project/osw` 里有没有对应物。**
  能与 osw 同版本就用同版本（版本范围照抄 osw 的 `package.json`，不要自己挑、不要 latest）；
  **不引入 osw 没有的技术栈**。两侧保持同构，将来才能合并为一个应用。
- 例外只有一种：abx 明确不需要的 osw 库可以不引（例如 `electron`、`drizzle`），
  这属于「少」，不属于「多一个 osw 没有的东西」。

### 暂缓未加依赖（等对应能力落地时再按 osw 的版本补）

osw 里有、abx 暂时没引的：`electron`、`electron-updater`、`drizzle-orm`、`drizzle-kit`、
CodeMirror 系列（`@codemirror/*`、`@lezer/highlight`）、Radix 系列（`radix-ui`、`@base-ui/react`）、
TanStack 系列（`@tanstack/react-query`、`@tanstack/react-router`）、`recharts`、`@xyflow/react`，
以及 Tailwind 系列、`zustand`、`motion` 等界面库。

要加时先读 osw 的 `package.json` 取版本，不要凭记忆写。

## 代码约定

- `packages/toolkit/` 里的脚本是工具链本身，**除非必要不要改动其逻辑**；
  需要新增检查项时优先加在配置或新脚本里，而不是改写现有脚本的语义。
- 包之间的依赖方向由 `packages/toolkit/scripts/check-package-boundaries.mjs` 守着：
  `packages/*` 不得依赖 `apps/*`，跨包引用必须在 `package.json` 里声明依赖。
- 新增包时同步更新 `packages/<name>/package.json`、`tsconfig.json`，版本号与根保持一致
  （`pnpm version:set <version>` 会把根版本刷到每一个包）。
- 目录职责：`packages/*` 放库（contracts=类型/schema、core=领域逻辑、console=Web UI、
  toolkit=工具链），`apps/*` 放入口程序。产品能力（代理、沙箱）只落在 `packages/core` 里，
  由 `apps/app` 这样的宿主跑起来。

## 预留目录

以下目录**尚未创建**，将在对应能力落地时按 osw 的方式建：

- `apps/app/` —— Electron 桌面壳（osw 里是 `@osw/app`，含托盘、更新器、打包脚本）。
  abx 需要桌面形态时再建，届时同步引 electron 系列依赖。
- `apps/docs/` —— ✅ **已创建**。与 osw 同构：`specs/` 放内部规格（不进静态站），
  `source/` 放面向使用者的文档（尚未开写）。文档站本身未搭建，`dev`/`build` 是占位。
  入口：`apps/docs/specs/README.md`（文档地图）、`apps/docs/roadmap.md`（进度与验收）。

`apps/app` 是 `pnpm-workspace.yaml` 的 `apps/*` 通配范围内的成员，创建后
包边界校验与版本校验会自动纳入，无需改工具链脚本。

## 文档

所有文档住在 `apps/docs/`（与 osw 同构）。

- **规格文档**（内部，只服务实现与评审）：`apps/docs/specs/<簇>/*.md`
- **使用者文档**（未来，双语）：`apps/docs/source/<locale>/`
- **文档地图**：`apps/docs/specs/README.md` —— 加文档前先看它，加了就往表里补一行
- **进度与验收状态**：`apps/docs/roadmap.md` —— **唯一来源**，其它文档不写「做到哪一步」

**一个主题只在一份文档里展开**，其它地方提到它只写结论加链接。
