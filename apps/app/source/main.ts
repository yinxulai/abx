// Electron 主进程 = Composition Root（ARCHITECTURE.md §8 / R6）。
// 这里只做「接线」：造托盘、造面板窗口、把 IPC 接到 core 的命令上。
// 编排逻辑一律住在 `@abx/core`，所以它能在没有 GUI 的机器上被测试。
import { app, BrowserWindow, Tray, ipcMain, nativeImage, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSharedEntry, type SharedEntry, type SharedEntryRejection, type SharedListSnapshot } from '@abx/contracts'
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

const here = path.dirname(fileURLToPath(import.meta.url))
/** 面板产物：`@abx/console` 构建到 `output/panel`，与主进程产物同级。 */
const PANEL_ENTRY = path.join(here, '../panel/index.html')
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

/** 把面板贴到托盘图标下方，并夹在屏幕可视区内。 */
function placePanel(window: BrowserWindow): void {
  if (tray === null) return
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const workArea = display.workArea
  const bounds = window.getBounds()

  const centered = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2)
  const x = Math.min(Math.max(centered, workArea.x), workArea.x + workArea.width - bounds.width)
  const y = Math.round(trayBounds.y + trayBounds.height)
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

function createTray(): Tray {
  // 模板图（`Template` 后缀）由 macOS 自动按明暗反色，不需要准备两套资源。
  const icon = nativeImage.createFromPath(path.join(here, '../../build/trayTemplate.png'))
  const created = new Tray(icon)
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

  const { mounts, rejected } = resolveSharedMounts(incoming)
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
})

// 托盘应用：最后一个窗口关掉不等于退出，退出只由「退出」动作触发。
// 这个事件的处理器不接收参数 —— 之前签名里带 `event` 是错的。
app.on('window-all-closed', () => {})
