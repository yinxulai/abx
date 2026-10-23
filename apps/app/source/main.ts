// Electron 主进程 = Composition Root（ARCHITECTURE.md §8 / R6）。
// 这里只做「接线」：造托盘、造面板窗口、把 IPC 接到 core 的命令上。
// 编排逻辑一律住在 `@abx/core`，所以它能在没有 GUI 的机器上被测试。
import { app, BrowserWindow, Tray, ipcMain, nativeImage, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 面板宽度。与托盘卡片 366 + 左右各 28 的透明阴影留白对齐（见 tray-ui.md）。 */
const PANEL_WIDTH = 422
/** 卡片外面的透明留白，专给阴影用。 */
const PANEL_GUTTER = 28
const PANEL_MIN_HEIGHT = 120

const here = path.dirname(fileURLToPath(import.meta.url))
let tray: Tray | null = null
let panel: BrowserWindow | null = null
let panelHeight = 320

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
      preload: path.join(here, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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

ipcMain.on('panel:height', (_event, height: unknown) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return
  panelHeight = height
  panel?.setContentSize(PANEL_WIDTH, contentHeight(height))
})

ipcMain.on('panel:hide', () => panel?.hide())

app.whenReady().then(() => {
  tray = createTray()
  panel = createPanel()
})

// 托盘应用：最后一个窗口关掉不等于退出，退出只由「退出」动作触发。
// 这个事件的处理器不接收参数 —— 之前签名里带 `event` 是错的。
app.on('window-all-closed', () => {})
