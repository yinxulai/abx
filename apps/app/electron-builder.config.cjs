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
    // 托盘图标是**运行期**由主进程按 `../../build/*.png` 读的
    // （`output/main/index.js` 往上两级）。不显式收进来，打包后只有一种表现：
    // app 起来了，菜单栏里什么都没有。
    //
    // 三张都要收：`trayTemplate*` 是 macOS 的模板字形，`icon.png` 是 Linux 那份
    // （非 macOS 不做模板反色，见 `source/main.ts` 的 `trayIcon()`）。
    // `icon.png` 同时还是 electron-builder 构建 app 图标时的输入，两件事互不冲突。
    'build/trayTemplate.png',
    'build/trayTemplate@2x.png',
    'build/icon.png',
    // Windows 那份：多尺寸 ICO，通知区按 DPI 自己挑一档（16/20/24/32/48/64/256）。
    // 它同时是 `win.icon`（exe 与安装器的图标）——一份资产两个用途，
    // 因为两边要的本来就是同一张图。
    'build/icon-win.ico',
    // 面板渲染层（`packages/console` 构建产物）落地后，在这里补一条
    // `{ from: '../../packages/console/output', to: 'output/render' }`，
    // 并让主进程按 `__dirname/../render` 反推它——两边是一组，改一处必须改全部。
  ],
  // 还没有更新器（未引入 electron-updater），所以不写 `publish` 段：
  // 打包一律 `--publish never`，产物只作为 CI artifact 供下载。
  // 接上更新器时再按 OSW 的写法补 GitHub provider。
  afterPack: 'scripts/macos-adhoc-sign.cjs',
  // Linux 不是发布平台，存在的理由是「开发机能把它跑起来、看得出样子」——
  // 开发机是 Linux 且没有物理显示器，详见 `apps/docs/specs/overview/platforms.md`。
  // 产物与 macOS 一样只作为 CI artifact（全程 `--publish never`）。
  //
  // `icon` 指回同一张应用图标：Linux 的 .desktop / AppImage 要的是彩色方图，
  // 而 macOS 那份 `icon-mac.png` 是给 `.icns` 用的，两边不能共用一条配置。
  linux: {
    icon: 'build/icon.png',
    // 必须显式写：不写时 electron-builder 拿包名 `@abx/app` 去推导可执行文件名，
    // 去掉非法字符后得到 `@abxapp`，AppImage 会直接拒绝：
    //   executableName contains characters that cannot be safely used in file paths
    // 写在各平台分支里而不是顶层，是为了不碰 macOS 既有的产物命名。
    executableName: 'abx',
    // AppImage 免安装、直接双击；deb 覆盖走包管理器的机器。两个都不需要签名。
    target: ['AppImage', 'deb'],
    // freedesktop 分类：abx 是给开发者用的工具，不是系统实用程序。
    category: 'Development',
  },
  // Windows 是**用户日常测试平台**（见 `apps/docs/specs/overview/platforms.md` §0）：
  // macOS 是发布平台，Windows 是「改完就在这台机器上看一眼」的那台。所以这里给两种产物：
  //   - `nsis`     装到机器上、有开始菜单项、能卸载，给日常使用；
  //   - `portable` 单个 exe，双击就跑，给「换台机器试一下」和 CI 自测。
  //
  // 架构只给 x64：`windows-latest` runner 是 x64，而 arm64 的 Windows 上 x64 也能跑
  // （系统自带仿真）。两个都打会让这条流水线的时间翻倍，而第二种产物现在没人要。
  //
  // 与 macOS/linux 一样**不签名**：没有证书，也没有第二台机器去验签名后的行为。
  // 未签名的后果要说清楚——用户第一次运行会看到 SmartScreen 的蓝色警告，
  // 要点「更多信息 → 仍要运行」。这不是 bug，是这一版没买证书的代价。
  win: {
    // electron-builder 要 ≥256px 的图；这份 ICO 里最大一档就是 256。
    icon: 'build/icon-win.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  // 显式的「不签名」。留着它是有意的：electron-builder 的默认行为是**发现证书就签**，
  // 而 `forceCodeSigning` 为 false 表示「没签也照样出包」——这两句话合起来才是
  // 「本仓库不使用签名凭据」这个决定本身，和 `mac.identity: null` 是同一个意思。
  forceCodeSigning: false,
  nsis: {
    // 一键安装（默认 true）会直接开始装、不给选目录的机会。abx 是个开发工具，
    // 装哪儿用户想说了算。
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // 按用户装，不按机器装：按机器装要管理员权限，而这个应用的功能
    // （起容器、挂本地目录）本来就都跑在当前用户名下。
    perMachine: false,
    // 快捷方式名字不要带产品名的后缀（默认会生成 `ABX (User)` 那种）。
    // 第一版不建桌面快捷方式：托盘应用多一个桌面图标只会让人以为要双击启动。
    createDesktopShortcut: false,
    shortcutName: 'ABX',
  },
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
