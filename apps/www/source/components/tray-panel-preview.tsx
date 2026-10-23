import { FileText, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AirlockMark } from './airlock-mark'

/**
 * 面板里的三个 agent 方块，用的是**面板上的短名**（`Claude` / `Codex` / `dsh`），
 * 不是清单里的全名（`Claude Code` / `OpenAI Codex CLI`）——这里画的是托盘面板，
 * 按 `product/tray-ui.md` 的布局与文案；「agent 是什么」那种数据在
 * `agent-overview.tsx` 里，那一节才是从 contracts 读的。
 */
const PANEL_AGENTS = [
  { initial: 'C', label: 'Claude', running: true },
  { initial: 'X', label: 'Codex', running: true },
  { initial: 'D', label: 'dsh', running: false },
] as const

const SHARED = ['design-spec.pdf', 'api-contract.md'] as const

/**
 * 托盘面板示意。按 `product/tray-ui.md` 的布局绘制，**不是产品截图** ——
 * 桌面壳还在开发中，所以标注为「示意」。
 *
 * 整块对辅助技术隐藏，信息由可见的 `figcaption` 承担，避免读屏念一堆装饰文字。
 * 字号比规格里的 11px 抬到 12px：官网的 `audit.mjs` 有一条「不许有 11px 以下的
 * 文字」的判据，而这只是张示意图，没有像素级还原的义务。
 */
export const TrayPanelPreview = () => {
  const { t } = useTranslation()

  return (
    <figure className="mx-auto w-full max-w-[400px]">
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-[14px] border border-line-strong bg-surface-0 shadow-[0_24px_60px_rgb(0_0_0/0.28)]"
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-1">
            <AirlockMark className="size-5 text-ink-2" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">abx</p>
            <p className="mt-1 text-xs text-ink-3">
              {t('tray.status', '气闸运行中 · 凭据全部在舱外')}
            </p>
          </div>
          <p className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
            <span className="size-1.5 rounded-full bg-mint" />
            {t('tray.cells', '2 舱')}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 px-3.5 py-3">
          {PANEL_AGENTS.map(agent => (
            <div
              className="flex flex-col items-center gap-2 rounded-md border border-line bg-surface-1 px-2 py-2.5"
              key={agent.label}
            >
              <span
                className={
                  agent.running
                    ? 'grid size-7 place-items-center rounded-[6px] bg-ink text-xs font-semibold text-void'
                    : 'grid size-7 place-items-center rounded-[6px] border border-line bg-surface-2 text-xs font-medium text-ink-4'
                }
              >
                {agent.initial}
              </span>
              <span className={agent.running ? 'text-xs text-ink' : 'text-xs text-ink-3'}>
                {agent.label}
              </span>
            </div>
          ))}
        </div>

        <div className="px-3.5 pb-3">
          <p className="flex items-baseline justify-between text-xs text-ink-3">
            {t('tray.shared', '共享给全部 agent')}
            <span className="text-ink-4">{t('tray.sharedCount', '2 项')}</span>
          </p>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-md border border-line">
            {SHARED.map(name => (
              <li className="flex min-h-10 items-center gap-2 px-2.5 py-2 text-xs" key={name}>
                {name.endsWith('/') ? (
                  <Folder aria-hidden="true" className="size-3.5 shrink-0 text-ink-4" />
                ) : (
                  <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-4" />
                )}
                <span className="text-ink-2">{name}</span>
                <span className="ml-auto shrink-0 rounded border border-line px-1.5 py-1 text-xs text-ink-4">
                  {t('tray.readOnly', '只读')}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 rounded-md border border-dashed border-line-strong px-2.5 py-3 text-center text-xs text-ink-3">
            {t('tray.dropHint', '把文件拖到这里 → 全部 agent 立刻可见')}
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-line px-3.5 py-2 text-xs">
          <span className="text-ink-3">{t('tray.audit', '审计流水…')}</span>
          <span className="flex items-center gap-3">
            <span className="text-rose">{t('tray.stopAll', '停止全部')}</span>
            <span className="text-ink-2">{t('tray.quit', '退出')}</span>
          </span>
        </div>
      </div>

      <figcaption className="mt-3 text-center text-xs text-ink-4">
        {t('tray.caption', '面板示意 · 按产品规格绘制，桌面壳仍在开发中')}
      </figcaption>
    </figure>
  )
}
