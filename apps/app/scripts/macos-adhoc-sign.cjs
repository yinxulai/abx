const { execFileSync } = require('node:child_process')
const path = require('node:path')

// electron-builder 的 `afterPack` 钩子：macOS 产物在打包完成后做一次 ad-hoc 签名。
//
// 为什么需要：`mac.identity: null` 让 electron-builder 跳过签名，而一个完全未签名的
// `.app` 在 Apple Silicon 上连启动都会被系统拒绝（arm64 强制要求至少是 ad-hoc 签名）。
// ad-hoc（`codesign -s -`）不校验身份、不需要证书，够本机与内部测试跑起来；
// 它**不等于**可信签名——分发给别人仍然要真证书 + 公证。
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  )
  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  )
}
