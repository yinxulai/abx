/**
 * 面板贴在托盘图标的哪一边。
 *
 * 这不是「一个平台一套规则」，而是**一个几何问题**：托盘图标在屏幕下半部分时，
 * 「贴在图标下面」就是屏幕外面。macOS 的菜单栏常驻顶部，所以「永远贴在下面」在
 * 开发机与 macOS 上都对；Windows 的任务栏默认在**底部**，同一个算法把面板送到了
 * 任务栏下面——窗口存在、可见、拿到了焦点，但用户什么都看不到。
 *
 * 所以判定用的是坐标，不是 `process.platform`：任务栏在 Windows 上也能被用户拖到
 * 顶部或左右（这时「贴下面」又是对的），跟着坐标走就自动对了，跟着平台走反而错。
 *
 * 纯函数，输入是三个矩形：图标在哪、可用的桌面区域、面板多大。于是
 * 「任务栏在底 / 在顶 / 在左 / 在右 / 面板比工作区还高」这几种都能在 Linux 上验完。
 */

/** 一个屏幕矩形。与 Electron 的 `Rectangle` 同形。 */
export interface PanelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PanelPlacementInput {
  /** 托盘图标的屏幕坐标（`Tray.getBounds()`）。 */
  readonly trayBounds: PanelRect
  /** 该显示器的可用区域（`Display.workArea`，已扣掉任务栏/菜单栏）。 */
  readonly workArea: PanelRect
  readonly panelSize: { readonly width: number; readonly height: number }
  /** 图标与面板之间留的缝。默认 0：现在贴紧，留白由面板自己的透明阴影撑。 */
  readonly gap?: number
}

/**
 * 算出面板左上角该在哪。
 *
 * 两条规则，顺序不能反：
 *   1. **优先贴下面。** 图标下面放不下（会超出工作区底边）时才改贴上面。
 *      先判「上面放得下吗」的话，macOS 菜单栏上（图标在最顶）会因为「上面放不下」
 *      而贴到下面——那恰好是想要的，但推理是反的，读代码的人会以为哪里写错了。
 *   2. 最后两个方向都夹进工作区。夹的是**结果**，不是「先夹再判断」：
 *      面板比工作区还高的时候（小屏 + 大面板），夹完必然有一段在屏幕外，
 *      这时至少保证顶边可见——顶边可见还能看到标题，底边可见就只能看到空白。
 */
export function panelPosition(input: PanelPlacementInput): { readonly x: number; readonly y: number } {
  const gap = input.gap ?? 0
  const { trayBounds, workArea, panelSize } = input

  const below = trayBounds.y + trayBounds.height + gap
  const above = trayBounds.y - gap - panelSize.height
  const roomBelow = workArea.y + workArea.height - panelSize.height

  const preferred = below <= roomBelow ? below : above
  const y = clamp(preferred, workArea.y, roomBelow)

  const centered = Math.round(trayBounds.x + trayBounds.width / 2 - panelSize.width / 2)
  const x = clamp(centered, workArea.x, workArea.x + workArea.width - panelSize.width)

  return { x, y }
}

/**
 * 夹进 `[min, max]`。
 *
 * `max < min` 时返回 `min`：那表示「面板比可用区域还大」，此时贴顶边是唯一
 * 还能看的选择。用 `Math.min(Math.max(...))` 直接套的话这里会返回 `max`，
 * 也就是把面板推到屏幕外面去——正是要避免的那件事。
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
