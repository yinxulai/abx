export interface DropZoneProps {
  /** 有东西正悬在面板上，虚线框高亮。 */
  readonly dragging: boolean
}

/**
 * 拖放区的文案。**只有这一句，空态和非空态都是它**（`tray-ui.md` §7 第 3 条定的）。
 *
 * 原来空态那句是「把文件拖到**托盘图标**，或拖到这里」，它把面板和托盘图标混成了一句话，
 * 而拖到托盘图标是 **macOS only**（Windows 上 `Tray` 不接拖放）——面板内的文案只说面板，
 * 平台相关的写法不进正文。
 */
const DROP_HINT = '拖到这里 → 全部 agent 立刻可见'

/**
 * 拖放区。路径的提取不在 React 这一侧：dragover/drop 的宿主监听装在 preload 里
 * （HTML5 的 `File` 只能用 `webUtils` 换绝对路径，那是宿主能力）。
 * 这里只负责「看起来能不能放」——虚线与高亮。
 */
export function DropZone(props: DropZoneProps) {
  return (
    <div
      className="abx-dropzone"
      data-active={props.dragging}
      role="region"
      aria-label="拖放区"
    >
      {DROP_HINT}
    </div>
  )
}
