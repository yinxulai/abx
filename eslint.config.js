import tsParser from '@typescript-eslint/parser'
import peculiar from '@yinxulai/eslint-plugin-peculiar'

export default [
  {
    ignores: [
      'output/**',
      'packages/*/output/**',
      'apps/*/output/**',
      'node_modules/**',
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
