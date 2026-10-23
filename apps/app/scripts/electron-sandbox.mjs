// Electron 的 `--no-sandbox` 该不该加，由**实际能力**决定，不由平台名决定。
//
// 背景：Chromium 在 Linux 上靠一个 SUID helper（`chrome-sandbox`）做沙箱。这个文件
// 必须属于 root 且带 setuid 位，否则 Chromium **直接 abort**，只留一行
// 「The SUID sandbox helper binary was found, but is not configured correctly」。
// 开发机（非特权用户、容器、`pnpm` 装出来的 `node_modules`）几乎都不满足这个条件——
// 文件属于当前用户、没有 setuid，于是 `electron .` 连窗口都没开就退出。
//
// 为什么不在 `main.ts` 里 `app.commandLine.appendSwitch('no-sandbox')`：
// 那会让**打包后的产品**也永远关掉沙箱。这里只在开发脚本里判断，且判断的是
// 「这台机器上的 helper 到底能不能用」，能用就一个参数都不加。
//
// macOS / Windows 不走这条路径（它们的沙箱实现不同），一律不加参数。
import { statSync } from 'node:fs'
import path from 'node:path'

/** setuid 位：`stat.mode` 里的 04000。 */
const SETUID = 0o4000

/**
 * SUID helper 是否真的可用：必须是 root 所有**且**带 setuid 位。
 * 两个条件缺一不可——只改属主或只加 setuid 都会被 Chromium 拒绝。
 */
function sandboxHelperIsUsable(electronBinary) {
  const helper = path.join(path.dirname(electronBinary), 'chrome-sandbox')
  try {
    const stats = statSync(helper)
    return stats.uid === 0 && (stats.mode & SETUID) !== 0
  } catch {
    // 没有这个文件（例如某些发行版把它装在别处）时按「不可用」处理：
    // 宁可多加一个 `--no-sandbox`，也不要让 app 起不来。
    return false
  }
}

/**
 * 启动 Electron 时该补的参数。
 *
 * @param {string} electronBinary `electron` 包解析出来的可执行文件绝对路径
 * @returns {string[]} 追加到命令行末尾的参数
 */
export function sandboxArguments(electronBinary) {
  if (process.platform !== 'linux') return []
  if (sandboxHelperIsUsable(electronBinary)) return []
  return ['--no-sandbox']
}
