// 开发期启动：先构建面板、主进程与 preload，再用 electron 拉起。
// 本机若没有 DISPLAY，这个脚本会失败——那是环境限制，不是代码问题。
import { spawnSync } from 'node:child_process'

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['scripts/build.mjs'])
run('pnpm', ['exec', 'electron', '.'])
