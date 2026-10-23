import type { DragEventHandler, ReactNode, RefObject } from 'react'

export interface PanelCardProps {
  /** 当前有几个舱在跑。0 表示气闸未启动。 */
  readonly runningCount: number
  /** 有东西正悬在卡片上，卡片外框加一圈 ring。 */
  readonly dragging: boolean
  /** 卡片本体，渲染层量它的高度上报给宿主窗口。 */
  readonly cardRef: RefObject<HTMLElement | null>
  readonly onDragOver: DragEventHandler<HTMLElement>
  readonly onDragLeave: DragEventHandler<HTMLElement>
  readonly onDrop: DragEventHandler<HTMLElement>
  readonly children: ReactNode
}

/**
 * 面板本体：一张 366 宽、圆角带阴影的卡片，也是拖放的落点。
 *
 * 外观（圆角 10、双层阴影、`foreground/.14` 边框）逐条来自
 * `apps/docs/specs/product/tray-ui.md` §2.4；数字写进 CSS 变量，不在这里硬编码。
 * 高度不写死：卡片由内容撑开，`useReportHeight` 量完交给宿主。
 */
export function PanelCard(props: PanelCardProps) {
  const running = props.runningCount > 0

  return (
    <section
      className="abx-card"
      data-dragging={props.dragging}
      ref={props.cardRef}
      aria-label="abx 托盘面板"
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      <header className="abx-header">
        <span className="abx-mark" aria-hidden="true">
          a
        </span>
        <span className="abx-title">
          <strong className="abx-title-name">abx</strong>
          <span className="abx-title-sub">
            {running ? '气闸运行中 · 凭据全部在舱外' : '气闸待启动 · 凭据全部在舱外'}
          </span>
        </span>
        <span className="abx-status" data-running={running} role="status" aria-live="polite">
          <span className="abx-status-dot" aria-hidden="true" />
          {running ? `${props.runningCount} 舱` : '待启动'}
        </span>
      </header>
      {props.children}
    </section>
  )
}
