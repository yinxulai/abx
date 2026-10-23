import { AirlockMark } from './airlock-mark'

const AGENTS = [
  { initial: 'C', label: 'Claude', running: true },
  { initial: 'X', label: 'Codex', running: true },
  { initial: 'D', label: 'dsh', running: false },
] as const

const SHARED = [
  { kind: 'file', name: 'design-spec.pdf' },
  { kind: 'file', name: 'api-contract.md' },
  { kind: 'folder', name: 'assets/' },
] as const

/**
 * 托盘面板示意。图形按 `product/tray-ui.md` 的布局与文案绘制，
 * **不是产品截图** —— 桌面壳还在开发中，所以标注为「示意」。
 * 整块对辅助技术隐藏，信息由可见的 `figcaption` 承担，避免读屏念一堆装饰文字。
 */
export const TrayPanelPreview = () => (
  <figure className="mx-auto w-full max-w-[400px]">
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[14px] border border-line-strong bg-surface-0 shadow-[0_24px_60px_rgb(0_0_0/0.45)]"
    >
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-1">
          <AirlockMark className="size-5 text-ink-2" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">abx</p>
          <p className="mt-0.5 text-[11px] text-ink-3">气闸运行中 · 凭据全部在舱外</p>
        </div>
        <p className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3">
          <span className="size-1.5 rounded-full bg-mint" />2 舱
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 px-3.5 py-3">
        {AGENTS.map(agent => (
          <div
            className="flex flex-col items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 py-2.5"
            key={agent.label}
          >
            <span
              className={
                agent.running
                  ? 'grid size-7 place-items-center rounded-[6px] bg-ink text-[11px] font-semibold text-void'
                  : 'grid size-7 place-items-center rounded-[6px] border border-line bg-surface-2 text-[11px] font-medium text-ink-4'
              }
            >
              {agent.initial}
            </span>
            <span className={agent.running ? 'text-[11px] text-ink' : 'text-[11px] text-ink-3'}>
              {agent.label}
            </span>
          </div>
        ))}
      </div>

      <div className="px-3.5 pb-3">
        <p className="flex items-baseline justify-between text-[11px] text-ink-3">
          共享给全部 agent
          <span className="text-ink-4">3 项</span>
        </p>
        <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-md border border-line">
          {SHARED.map(item => (
            <li className="flex min-h-10 items-center gap-2 px-2.5 py-2 text-[11px]" key={item.name}>
              <FileGlyph folder={item.kind === 'folder'} />
              <span className="truncate text-ink-2">{item.name}</span>
              <span className="ml-auto shrink-0 rounded border border-line px-1 py-0.5 text-[10px] text-ink-4">
                只读
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 rounded-md border border-dashed border-line-strong px-2.5 py-2.5 text-center text-[11px] text-ink-3">
          把文件拖到这里 → 全部 agent 立刻可见
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-line px-3.5 py-2 text-[11px]">
        <span className="text-ink-3">审计流水…</span>
        <span className="flex items-center gap-3">
          <span className="text-rose">停止全部</span>
          <span className="text-ink-2">退出</span>
        </span>
      </div>
    </div>

    <figcaption className="mt-3 text-center text-xs text-ink-4">
      面板示意 · 按产品规格绘制，桌面壳仍在开发中
    </figcaption>
  </figure>
)

type FileGlyphProps = { folder: boolean }

const FileGlyph = ({ folder }: FileGlyphProps) =>
  folder ? (
    <svg aria-hidden="true" className="size-3 shrink-0 text-ink-4" fill="none" viewBox="0 0 12 12">
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h2l1 1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg aria-hidden="true" className="size-3 shrink-0 text-ink-4" fill="none" viewBox="0 0 12 12">
      <path
        d="M3 1.5h4l2.5 2.5v6a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-8A.5.5 0 0 1 3 1.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="M7 1.5V4h2.5" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
