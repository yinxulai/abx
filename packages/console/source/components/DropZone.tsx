export interface DropZoneProps {
  /** 共享区已有条目时换一句「拖进来立刻可见」的提示。 */
  readonly hasEntries: boolean
  /** 有东西正悬在面板上，虚线框高亮。 */
  readonly dragging: boolean
}

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
      {props.hasEntries ? '拖到这里 → 全部 agent 立刻可见' : '把文件拖到托盘图标，或拖到这里'}
    </div>
  )
}
