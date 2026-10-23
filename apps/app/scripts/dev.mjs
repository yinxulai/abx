// 开发期启动：先构建面板、主进程与 preload，再用 electron 拉起。
//
// Linux 上会额外补 `--no-sandbox`，条件是这台机器的 SUID helper 真的不可用
// （见 `electron-sandbox.mjs`）。本机若没有 `DISPLAY`，这个脚本仍然会失败——
// 那是环境限制，不是代码问题；要无头跑一遍并留下截图，用 `verify:linux`。
import { spawnSync } from 'node:child_process'
import electronBinary from 'electron'
import { sandboxArguments } from './electron-sandbox.mjs'

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['scripts/build.mjs'])

const extra = sandboxArguments(electronBinary)
if (extra.length > 0) {
  console.warn(
    `[abx] chrome-sandbox 不可用（需要 root 所有且带 setuid），本次启动追加 ${extra.join(' ')}`,
  )
}
// 直接执行 electron 的二进制，而不是 `pnpm exec electron`：参数要按顺序接在
// 可执行文件之后，多一层包管理器只会让「谁吃了这个参数」变得难以判断。
run(electronBinary, [...extra, '.'])
