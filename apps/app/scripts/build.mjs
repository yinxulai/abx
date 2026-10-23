// 宿主的三份产物，都在 `output/` 下：
//   panel/    面板（由 @abx/console 构建，直接落进这里，主进程按相对路径加载）
//   main/     主进程（ESM）
//   preload/  preload（CJS，沙箱 preload 不支持 ESM）
//
// 面板先构建：主进程构建时不清理 output，所以顺序只影响「第一次是否缺文件」。
import { spawnSync } from 'node:child_process'

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('pnpm', ['--filter', '@abx/console', 'exec', 'vite', 'build', '--outDir', '../../apps/app/output/panel'])
run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.ts'])
run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.preload.config.ts'])
