import tsParser from '@typescript-eslint/parser'
import peculiar from '@yinxulai/eslint-plugin-peculiar'

export default [
  {
    ignores: [
      'output/**',
      'packages/*/output/**',
      'apps/*/output/**',
      'node_modules/**',
      // 扁平配置里的 ignore 是相对仓库根的最小匹配，`release/**` 只盖住根目录那一份；
      // 而 `.gitignore` 里写的是不带锚点的 `release`，`apps/cli/release/` 同样不进仓库。
      // 不补这一行，本地留下的命令行发布产物会被当成源码检查（几百条压缩代码的报错）。
      'release/**',
      'apps/*/release/**',
      'coverage/**',
    ],
  },
  ...peculiar.configs['flat/strict'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
]
