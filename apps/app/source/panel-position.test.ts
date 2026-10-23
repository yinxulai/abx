import { describe, expect, it } from 'vitest'
import { panelPosition, type PanelRect } from './panel-position'

/*
 * 面板位置的四种屏幕，全部在 Linux 上跑。这正是当初把它从 `main.ts` 里抠出来的原因：
 * 原来那三行「贴下面 + 夹 x」在开发机（无头 Linux，没人看窗口）和 macOS 上都对，
 * 唯一错的那台机器是 Windows —— 而 Windows 恰恰是这次要支持的平台。
 */

const PANEL = { width: 422, height: 300 }

/** 1920×1080 的屏幕，底部 40px 是任务栏 —— Windows 的默认样子。 */
const WINDOWS_TASKBAR_BOTTOM: PanelRect = { x: 0, y: 0, width: 1920, height: 1040 }
/** macOS：顶部 25px 是菜单栏。 */
const MAC_MENU_BAR_TOP: PanelRect = { x: 0, y: 25, width: 1920, height: 1055 }
/** 用户把任务栏拖到了顶部。 */
const TASKBAR_TOP: PanelRect = { x: 0, y: 40, width: 1920, height: 1040 }
/** 任务栏在左边（竖排）。 */
const TASKBAR_LEFT: PanelRect = { x: 80, y: 0, width: 1840, height: 1080 }

/** 右下角通知区里的一个图标。 */
const TRAY_BOTTOM_RIGHT: PanelRect = { x: 1800, y: 1012, width: 24, height: 24 }
/** 菜单栏右上角的一个图标。 */
const TRAY_TOP_RIGHT: PanelRect = { x: 1800, y: 0, width: 24, height: 24 }

describe('panelPosition', () => {
  it('任务栏在底部（Windows 默认）：面板贴到图标**上面**，不是屏幕外面', () => {
    const { y } = panelPosition({
      trayBounds: TRAY_BOTTOM_RIGHT,
      workArea: WINDOWS_TASKBAR_BOTTOM,
      panelSize: PANEL,
    })
    // 贴下面会算成 1036，而 1036 + 300 远超工作区底边 1040 —— 窗口在屏幕外。
    expect(y).toBe(TRAY_BOTTOM_RIGHT.y - PANEL.height)
    expect(y + PANEL.height).toBeLessThanOrEqual(WINDOWS_TASKBAR_BOTTOM.y + WINDOWS_TASKBAR_BOTTOM.height)
  })

  it('菜单栏在顶部（macOS）：贴下面，且不贴到菜单栏里去', () => {
    const { y } = panelPosition({
      trayBounds: TRAY_TOP_RIGHT,
      workArea: MAC_MENU_BAR_TOP,
      panelSize: PANEL,
    })
    // 图标下沿在 24，而工作区从 25 开始 —— 夹回来，面板不盖住菜单栏。
    expect(y).toBe(MAC_MENU_BAR_TOP.y)
  })

  it('任务栏被拖到顶部时，跟着坐标走：仍然贴下面', () => {
    // 这条是「判据是几何不是平台」的证据：同一个 Windows 上，任务栏位置一换，
    // 结论就换，而代码里一个字都没改。
    const { y } = panelPosition({
      trayBounds: { x: 1800, y: 16, width: 24, height: 24 },
      workArea: TASKBAR_TOP,
      panelSize: PANEL,
    })
    expect(y).toBe(40)
  })

  it('横向夹回工作区：图标在最右边时面板不能一半在屏幕外', () => {
    const { x } = panelPosition({
      trayBounds: TRAY_BOTTOM_RIGHT,
      workArea: WINDOWS_TASKBAR_BOTTOM,
      panelSize: PANEL,
    })
    expect(x).toBe(WINDOWS_TASKBAR_BOTTOM.width - PANEL.width)
  })

  it('任务栏在左边时，工作区左边那 80px 也要让开', () => {
    const { x } = panelPosition({
      trayBounds: { x: 20, y: 500, width: 24, height: 24 },
      workArea: TASKBAR_LEFT,
      panelSize: PANEL,
    })
    expect(x).toBe(TASKBAR_LEFT.x)
  })

  it('面板比工作区还高时，保住顶边——底边可见等于只能看到一块空白', () => {
    const { y } = panelPosition({
      trayBounds: TRAY_BOTTOM_RIGHT,
      workArea: { x: 0, y: 0, width: 1920, height: 200 },
      panelSize: PANEL,
    })
    expect(y).toBe(0)
  })

  it('两边都放不下时，夹回工作区顶部——而不是选一个放到屏幕外的位置', () => {
    // 500 高的可用区、300 高的面板、图标在 y=260：下面算出来 284（需要到 584，
    // 超出），上面算出来 -40（超出）。两个方向都不成立，此时唯一还能看的选择是
    // 顶边对齐工作区顶边。原来那三行代码会把 y 直接写成 284，于是面板下半截
    // 掉到屏幕外——而它「看起来」是贴合图标的。
    const workArea: PanelRect = { x: 0, y: 0, width: 1920, height: 500 }
    const { y } = panelPosition({
      trayBounds: { x: 900, y: 260, width: 24, height: 24 },
      workArea,
      panelSize: PANEL,
    })
    expect(y).toBe(0)
    expect(y + PANEL.height).toBeLessThanOrEqual(workArea.height)
  })

  it('gap 是可选参数，给了就两个方向都算进去', () => {
    const below = panelPosition({
      trayBounds: TRAY_TOP_RIGHT,
      workArea: MAC_MENU_BAR_TOP,
      panelSize: PANEL,
      gap: 8,
    })
    expect(below.y).toBe(TRAY_TOP_RIGHT.y + TRAY_TOP_RIGHT.height + 8)

    const above = panelPosition({
      trayBounds: TRAY_BOTTOM_RIGHT,
      workArea: WINDOWS_TASKBAR_BOTTOM,
      panelSize: PANEL,
      gap: 8,
    })
    expect(above.y).toBe(TRAY_BOTTOM_RIGHT.y - 8 - PANEL.height)
  })
})
