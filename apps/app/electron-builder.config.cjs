/** @type {import('electron-builder').Configuration} */
module.exports = {
  // 与 `apps/app/package.json#desktopName` 保持同一个值：macOS 的 CFBundleIdentifier
  // 由这里写进 Info.plist，两处不一致会出现「系统里的 app 身份」与「Electron 侧的身份」对不上。
  appId: 'com.yinxulai.abx',
  productName: 'ABX',
  icon: 'build/icon.png',
  directories: {
    output: '../../release/${version}',
  },
  // 注意：文件名不能包含空格。GitHub 会把 release 资产文件名中的空格替换为 "."，
  // 将来若接上更新器，它按 latest*.yml 中的原始文件名拼接下载 URL，会导致 404。
  artifactName: 'ABX-${version}-${os}-${arch}.${ext}',
  // projectDir 就是本包（`apps/app`），所以这里的路径一律相对它解析。
  files: [
    // `output` 与 `!` 那条必须**挨在一起**：electron-builder 会把连续的字符串项归一化成
    // 同一个 file set 的 `filter` 列表，而每个 `{ from, to }` 项各自独立成一个 set。
    // 一旦排除项和它要排除的正向模式被拆进两个 set，前者就退化成「只有排除项」的 set
    // ——`minimatchAll` 是逐个模式累进判定的，没有前置正向模式时排除项全部被跳过，
    // 于是静默失效。
    'output',
    '!output/**/*.map',
    // `node_modules` 整棵树都是死的：`vite.config.ts` 的 `external` 只放行 `electron`
    // 与 `node:` 内置模块，工作区包（`@abx/*`）全部被 Vite 打进 `output/main/*.js`。
    // 但工作区包同时写在 `dependencies` 里（turbo 靠它排序构建），electron-builder
    // 于是照单收下——收进去的全是 TypeScript 源码与 `*.test.ts`。
    // 将来若真的引入一个必须留在外部的运行期依赖，要同时改 `external` 和这里。
    '!node_modules',
    // 面板渲染层（`packages/console` 构建产物）落地后，在这里补一条
    // `{ from: '../../packages/console/output', to: 'output/render' }`，
    // 并让主进程按 `__dirname/../render` 反推它——两边是一组，改一处必须改全部。
  ],
  // 还没有更新器（未引入 electron-updater），所以不写 `publish` 段：
  // 打包一律 `--publish never`，产物只作为 CI artifact 供下载。
  // 接上更新器时再按 OSW 的写法补 GitHub provider。
  afterPack: 'scripts/macos-adhoc-sign.cjs',
  // 第一版只做 macOS（见 `apps/www` 的首页文案）。Windows / Linux 的目标等真要做时再加。
  mac: {
    icon: 'build/icon-mac.png',
    // ZIP 是将来 electron-updater 做自动更新用的，DMG 只负责首次安装；
    // 两个都留，省得接更新器时再回头改产物定义。
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    // 这一版**没有**代码签名证书，也不做公证：
    // 显式写 `identity: null` 是为了不让 electron-builder 去钥匙串里碰运气找证书，
    // `notarize: false` 是关掉公证（它需要 Apple ID 凭据）。
    // 可选签名走的是 electron-builder 约定的环境变量（CSC_LINK / CSC_KEY_PASSWORD），
    // 公证走 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID——
    // 真要用时从 CI secret 注入，仓库里只留变量名。
    // 现在给的是 `scripts/macos-adhoc-sign.cjs` 里的 ad-hoc 签名（`codesign -s -`），
    // 它不需要任何凭据，够本机自测。
    identity: null,
    notarize: false,
    // 托盘应用：隐藏 Dock 图标（`LSUIElement`），只在菜单栏出现。
    // 这是 Info.plist 里的声明，比运行期 `app.dock.hide()` 更早生效——
    // 后者在启动瞬间仍会闪一下 Dock 图标。
    extendInfo: {
      LSUIElement: true,
    },
  },
}
