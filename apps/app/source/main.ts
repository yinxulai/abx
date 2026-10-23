// Electron 主进程 = Composition Root（ARCHITECTURE.md §8 / R6）。
// 这里只做「接线」：造托盘、造面板窗口、把 IPC 接到 core 的命令上。
// 编排逻辑一律住在 `@abx/core`，所以它能在没有 GUI 的机器上被测试。
import { app, BrowserWindow, Tray, dialog, ipcMain, nativeImage, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSharedEntry, type SharedEntry, type SharedEntryRejection, type SharedListSnapshot } from '@abx/contracts'
import { requireHostPlatform } from '@abx/core/host-platform'
import type { HostPlatform } from '@abx/core/host-platform'
import { panelPosition } from './panel-position'
import {
  addSharedEntries,
  defaultSharedListPath,
  markMissingEntries,
  readSharedEntries,
  resolveSharedMounts,
  writeSharedEntries,
} from '@abx/core/session'

/** 面板宽度。与托盘卡片 366 + 左右各 28 的透明阴影留白对齐（见 tray-ui.md）。 */
const PANEL_WIDTH = 422
/** 卡片外面的透明留白，专给阴影用。 */
const PANEL_GUTTER = 28
const PANEL_MIN_HEIGHT = 120
/** 托盘槽位尺寸。Linux 托盘按 20–24px 渲染图标，22 是这套主题里最接近的一档。 */
const TRAY_ICON_SIZE = 22

const here = path.dirname(fileURLToPath(import.meta.url))
/** 面板产物：`@abx/console` 构建到 `output/panel`，与主进程产物同级。 */
const PANEL_ENTRY = path.join(here, '../panel/index.html')

/**
 * 宿主平台。**整个进程只在这里读一次** `process.platform`。
 *
 * 隔离规则一个平台一套（见 `@abx/core/host-platform`），所以「这台机器是什么系统」
 * 必须在做任何事之前定下来，然后**当成参数**往 core 里传。各处自己读 `process.platform`
 * 的后果是：那条分支只在真机上才走得到，开发机上（Linux）永远验不了 Windows 那套。
 *
 * 认不出的系统（`freebsd` 这类）这里**直接退出**，不硬跑。理由不是保守：
 * 没有规则的平台上那些闸门不会报错，只会**静默失效**——用户会得到一个「看起来起了、
 * 其实没有隔离」的会话，那比起不来坏得多。所以这句话在 `app.whenReady()` 之前说，
 * 而且要说人话：弹窗里就是 `UnsupportedHostPlatformError` 那段。
 */
const hostPlatform: HostPlatform = readHostPlatform()

function readHostPlatform(): HostPlatform {
  try {
    return requireHostPlatform(process.platform)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 弹窗在 `app.whenReady()` 之前就能用（Electron 特意允许 showErrorBox 这么做），
    // 托盘应用又没有终端可看，所以两处都写：弹窗给人，stderr 给日志。
    try {
      dialog.showErrorBox('abx 起不来', message)
    } catch {
      // 没有图形环境（无头 CI、Xvfb 没起来）时弹不出来，下面那句 stderr 还在。
    }
    console.error(`[abx] ${message}`)
    process.exit(1)
  }
}
let tray: Tray | null = null
let panel: BrowserWindow | null = null
let panelHeight = 320

/**
 * 共享列表落在哪儿。**只有这里算**，preload 与渲染层都拿不到路径——
 * 路径由 core 的 `defaultSharedListPath()` 给出（`~/.abx/shared.json`，
 * 跟着 `ABX_INSTANCES_ROOT` 走），主进程只是决定「用那个算法」。
 */
const sharedListPath = defaultSharedListPath()

/**
 * 上一次没进列表的条目与原因。
 *
 * 只在内存里，不落盘：它是「刚刚那一次拖放的结果」，重启之后没有意义。
 * 被拒的条目**不写进 shared.json**——写进去就成了「面板上看着共享了、实际没有」，
 * 而下一次打开面板时那一条看起来完全正常。
 */
let lastRejected: readonly SharedEntryRejection[] = []

function sharedSnapshot(): SharedListSnapshot {
  return {
    // 每次都给宿主现在的判断：条目失效（文件被删）标 missing，但**留在列表里**。
    entries: markMissingEntries(readSharedEntries(sharedListPath)),
    rejected: lastRejected,
  }
}

function contentHeight(cardHeight: number): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.round(cardHeight) + PANEL_GUTTER * 2)
}

function createPanel(): BrowserWindow {
  const window = new BrowserWindow({
    width: PANEL_WIDTH,
    height: contentHeight(panelHeight),
    frame: false,
    transparent: true,
    // 阴影由渲染层的卡片自己画，窗口本身不要叠一层系统阴影，否则会出现双层边。
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      // `.cjs`：沙箱里的 preload 没有 ESM 上下文，只认 CJS（见 vite.preload.config.ts）。
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 面板是自绘的：窗口本身没有任何内容，React 卡片由渲染层画。
  // 用 `loadFile` 而不是 `loadURL`：产物是静态文件，且 `base: './'` 让资源引用相对，
  // `file://` 下也能解析。
  window.loadFile(PANEL_ENTRY).catch((error: unknown) => {
    console.error('[abx] failed to load the tray panel', error)
  })

  // 失焦即隐藏，不销毁：重建窗口会让面板每次都有一次可见的空白帧。
  window.on('blur', () => window.hide())
  return window
}

/**
 * 把面板贴到托盘图标旁边，并夹在屏幕可视区内。
 *
 * 贴哪一边由 `panelPosition()` 按坐标算，不按平台：Windows 的任务栏默认在**底部**，
 * 「永远贴图标下面」在那台机器上等于把面板放到屏幕外面（窗口真的存在、真的拿到了
 * 焦点，就是看不见）。任务栏在 Windows 上还能被拖到顶部，所以判据必须是坐标。
 */
function placePanel(window: BrowserWindow): void {
  if (tray === null) return
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const bounds = window.getBounds()

  const { x, y } = panelPosition({
    trayBounds,
    workArea: display.workArea,
    panelSize: { width: bounds.width, height: bounds.height },
  })
  window.setPosition(x, y, false)
}

function togglePanel(): void {
  if (panel === null) panel = createPanel()
  if (panel.isVisible()) {
    panel.hide()
    return
  }
  placePanel(panel)
  panel.show()
}

/**
 * macOS 的模板字形。**开发版与正式版各一张**，按 `app.isPackaged` 挑。
 *
 * 同时开着打包版与 `pnpm dev` 时，菜单栏里会是两枚一模一样的图标，分不清哪个是哪个。
 * 开发版那张在标志右下角多一颗圆点（`scripts/generate-icons.mjs` 画的），一眼能分清。
 *
 * `setTemplateImage(true)` **必须显式调**，不能只靠文件名：Electron 的启发式认的是
 * 「文件名以 `Template` 结尾」，正式版那张正好满足，开发版那张（`trayTemplate-dev.png`）
 * 不满足——不显式声明的话，系统会把这张纯白图当彩色图画出来，而纯白压在浅色菜单栏上
 * 就是隐形的。模板图的形状只由 alpha 表达，macOS 自己着色。
 */
function trayTemplate(): Electron.NativeImage {
  const file = app.isPackaged ? 'trayTemplate.png' : 'trayTemplate-dev.png'
  const image = nativeImage.createFromPath(path.join(here, '../../build', file))
  image.setTemplateImage(true)
  return image
}

/**
 * 托盘图标。三个平台各取一份，因为「模板图」是 **macOS 独有**的语义：
 * 模板字形由系统按菜单栏明暗自动反色，所以那里给的是一张纯白 + alpha 的字形
 * （RGB 不参与，只取 alpha）；别的平台不做反色，同一张字形放到深色托盘上就是隐形的。
 *
 * Windows 与 Linux 都用彩色应用图标（亮暗底色上都看得见），但**形式不一样**：
 *   - Windows 走 ICO。通知区按 DPI 挑尺寸（100% 是 16px，125% 是 20px，150% 是 24px，
 *     200% 是 32px），一张固定像素的 PNG 交上去只会被 shell 硬缩放，在高 DPI 上发虚；
 *   - Linux 走 PNG，按托盘槽位那个 22px 先降好再交（托盘实现自己不做高质量缩放）。
 *
 * **外观没有在真机上验过**（见 `apps/docs/roadmap.md` 的未验证清单）：这台开发机是
 * Linux，没有 Windows 也没有 macOS。能确证的只有「文件在、尺寸对、`Tray` 收得下」
 * 这几件——`build/icon-win.ico` 里是 16/20/24/32/48/64/256 七张**各自按目标尺寸
 * 光栅化**的位图（不是把 1024 那张缩下去：那样 16px 的像素对齐只能靠运气），
 * 由系统按 DPI 自己挑一档。
 */
function trayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') return trayTemplate()
  if (process.platform === 'win32') {
    // ICO 自己带整套尺寸，**不要**再 resize：那样等于先把多尺寸压成一个尺寸，
    // 正好把 ICO 唯一的好处丢掉。
    return nativeImage.createFromPath(path.join(here, '../../build/icon-win.ico'))
  }
  // 应用图标是 1024px 的方图，托盘槽位只有 20 出头，先降下来再交给 Tray。
  return nativeImage
    .createFromPath(path.join(here, '../../build/icon.png'))
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
}

function createTray(): Tray {
  const created = new Tray(trayIcon())
  created.on('click', togglePanel)
  // 拖文件到托盘图标：macOS only。这是「共享给全部 agent」的主入口之一。
  created.on('drop-files', (_event, files) => {
    created.emit('abx:share-files', files)
  })
  return created
}

/**
 * 渲染层送来的条目。**不信它们**：路径必须过契约的 schema，kind 必须以宿主 stat 为准
 * （`resolveSharedMounts()` 会 stat，条目上带的那个 kind 只是界面预览）。
 */
function parseIncoming(raw: unknown): readonly SharedEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: SharedEntry[] = []
  for (const item of raw) {
    const parsed = parseSharedEntry(item)
    if (parsed.ok) entries.push(parsed.entry)
  }
  return entries
}

ipcMain.on('panel:height', (_event, height: unknown) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return
  panelHeight = height
  panel?.setContentSize(PANEL_WIDTH, contentHeight(height))
})

ipcMain.on('panel:hide', () => panel?.hide())

/** 面板要看当前共享区（刚挂载时问一次）。 */
ipcMain.handle('shared:list', () => sharedSnapshot())

/**
 * 拖进来的条目：解析 → 落盘 → 把快照回给面板。
 *
 * 这一层只做「列表 + 持久化 + 解析接口」。真正把 `mounts` 交给 `session.create`
 * 是会话那一条作业：那时它会 `readSharedEntries(sharedListPath)` 再
 * `resolveSharedMounts()` 一遍——**必须在起容器那一刻重算**，因为
 * 「加进来时是干净的」不代表「起容器时还是干净的」（目录里可能已经多了个 `.env`）。
 */
ipcMain.handle('shared:add', (_event, raw: unknown) => {
  const incoming = parseIncoming(raw)
  if (incoming.length === 0) return sharedSnapshot()

  const { mounts, rejected } = resolveSharedMounts(incoming, { platform: hostPlatform })
  // 被拒的按**原始路径**排除，不按解析后的路径：软链条目的挂载源是它的目标，
  // 两个集合的写法不一样，用路径对路径才准确。
  const rejectedPaths = new Set(rejected.map((item) => item.path))
  const accepted = incoming.filter((entry) => !rejectedPaths.has(entry.path))

  writeSharedEntries(sharedListPath, addSharedEntries(readSharedEntries(sharedListPath), accepted))
  lastRejected = rejected

  console.info(
    `[abx] shared: +${accepted.length} entry(ies) into ${sharedListPath}, ` +
      `${rejected.length} rejected, mount targets: ${mounts.map((mount) => mount.target).join(', ') || '(none)'}`,
  )
  return sharedSnapshot()
})

app.whenReady().then(() => {
  tray = createTray()
  panel = createPanel()
  // 无头验证用的开关：`Xvfb` 里没有托盘宿主，`getBounds()` 恒为 0×0，也没东西可点，
  // 面板就永远不会显示。置 1 时开局直接摊开面板，好让截图与 DOM 转储有东西可看。
  //
  // 默认关闭，产品路径一个字节都不变——它是「怎么看到面板」的开关，
  // 不是「面板长什么样」的开关。
  if (process.env.ABX_PANEL_SHOW_ON_START === '1') {
    placePanel(panel)
    panel.show()
  }
})

// 托盘应用：最后一个窗口关掉不等于退出，退出只由「退出」动作触发。
// 这个事件的处理器不接收参数 —— 之前签名里带 `event` 是错的。
app.on('window-all-closed', () => {})
