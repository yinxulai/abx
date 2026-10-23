import type { DragEventHandler, ReactNode, RefObject } from 'react'

export interface PanelCardProps {
  /**
   * 有没有在跑。它只影响副标题那一句，**不影响这里有没有一个胶囊**——
   * 「N 舱」那个胶囊已经按 `design-system.md` §8 去掉了：副标题说的是在不在跑，
   * 数量是管理面板的职责（`tray-ui.md` §3 里那张图也不再画它）。
   */
  readonly running: boolean
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
 * 外观（圆角 10、双层阴影、装饰性分隔线那种 `--border` 边框）逐条来自
 * `apps/docs/specs/product/design-system.md`；数字写进 CSS 变量，不在这里硬编码。
 * 高度不写死：卡片由内容撑开，`useReportHeight` 量完交给宿主。
 */
export function PanelCard(props: PanelCardProps) {
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
          {/* 面板是一份独立的文档（宿主里的一个窗口），标题层级从它起步——
              下面的 `共享给全部 agent` 是 `<h2>`，中间不能缺一级。 */}
          <h1 className="abx-title-name">abx</h1>
          {/* 副标题是面板上唯一一句状态，两档都**只说后果，不说术语**
              （`functional-design.md` §0.2 ②：不是「已开启隔离」，是「它看不到你电脑上的东西」）。
              所以这里不出现「气闸」「凭据」「舱」，也不出现数量 ——
              数量归管理面板（`design-system.md` §8）。 */}
          <span className="abx-title-sub">
            {props.running ? '运行中 · 它拿不到你的密钥' : '把文件拖进来，它就开始干活'}
          </span>
        </span>
      </header>
      {props.children}
    </section>
  )
}
