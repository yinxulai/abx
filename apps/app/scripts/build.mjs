import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 宿主构建。
//
//   node scripts/build.mjs                     只构建本包产物（主进程、preload）
//   node scripts/build.mjs --package           构建后交给 electron-builder 打包
//   node scripts/build.mjs --package --mac     打包指定平台（其余参数原样透传给 electron-builder）
//
// electron-builder 以本包为 projectDir：配置里的图标、`afterPack`、输出目录都相对它解析，
// 所以下面两条命令的工作目录都必须钉在这里，不能跟着调用方走。

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arguments_ = process.argv.slice(2)
const shouldPackage = arguments_.includes('--package')
const electronBuilderArguments = arguments_.filter(argument => argument !== '--package')

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: appDirectory, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.ts'])

if (!shouldPackage) process.exit(0)

// `--publish never`：本仓库还没有更新器，产物只作为 CI 的 artifact，
// 打包过程一律不许往外发东西。手动发布时同理（见 electron-builder.config.cjs）。
run('pnpm', [
  'exec',
  'electron-builder',
  '--config',
  'electron-builder.config.cjs',
  '--publish',
  'never',
  ...electronBuilderArguments,
])
