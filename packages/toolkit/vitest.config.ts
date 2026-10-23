import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 整个工作区共用的一份测试配置，经同目录下的 `scripts/test.mjs` 跑起来（可按包过滤）。
//
// 住在 toolkit 而不是仓库根：唯一消费方就是那个脚本，而 vitest 接受显式的 `--config`，
// 没有哪个工具非要它在根目录；根目录只留「工具约定必须在那里找到」的文件
// （`pnpm-workspace.yaml`、`turbo.json`、被各包 `extends` 的 `tsconfig.json`、`eslint.config.js`）。
// 与 `tsconfig.check.json` 同一个归属。
//
// `root` 显式钉在仓库根，而不是让它取 `cwd`：`include` 与覆盖率目录都是**相对 root** 解析的，
// 把 root 写明，配置挪位置时才不会顺手把这些的解释基准也挪走。
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: 'node',
    // 必须同时覆盖 .ts 与 .tsx，否则组件测试会被静默跳过，套件仍显示全绿。
    include: ['packages/*/source/**/*.test.{ts,tsx}', 'apps/*/source/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/source/**/*.{ts,tsx}', 'apps/*/source/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/types.ts', '**/schemas.ts', '**/test-support.ts'],
    },
  },
})
