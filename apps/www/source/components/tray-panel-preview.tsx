import { FileText, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TRAY_AGENT_ROWS } from '../agents'
import { AirlockMark } from './airlock-mark'

/**
 * 没在跑的那一档：虚线、中性色，**但描边必须看得见**。
 * 用的不是装饰性的 `line-strong`（在白底上只有 1.6:1，读起来像禁用），
 * 而是最弱的一档**文字**色 `ink-4`——`design-system.md` §5 对「可启动」的要求是
 * 「明显更高的对比，不能看起来像禁用」。虚线是形状，深灰是让它像能点的。
 */
const IDLE_TILE = 'relative grid size-11 place-items-center rounded-md border border-dashed border-ink-4 bg-surface-1'

/** 在跑的那一档：2px 实线，这一排里唯一的强调。 */
const RUNNING_TILE = 'relative grid size-11 place-items-center rounded-md border-2 border-ink bg-surface-1'

/**
 * 面板里正在跑的那一个。真实面板里这一排是活的，这里画的是**某一帧**：
 * 留一个在跑、一个没跑，两档状态才都看得见——只画一档，等于把另一档的画法藏起来。
 */
const RUNNING_IDS: readonly string[] = ['claude']

/**
 * 共享区里画的那几条。`assets/` 是目录，走文件夹图标那一支。
 * 右边那个计数由这个列表的长度算出来，**不另写一个数字**：两处写同一个数，
 * 就一定会有一天对不上。
 */
const SHARED = ['design-spec.pdf', 'api-contract.md', 'assets/'] as const

/**
 * 托盘面板示意。按 `product/tray-ui.md` §3 / §3.1 / §4 绘制，**不是产品截图** ——
 * 桌面壳还在开发中，所以标注为「示意」。
 *
 * 三件事在这一版里是**画法**，不是注释：
 * - **agent 那一排只有图标，没有名字**（§3，2026-10-23 定）。方块 44×44、左对齐、
 *   `gap 8`，一行放不下就折行，不横滚。名字在悬停与键盘聚焦时才出现，所以这里没有
 *   一行可见的 agent 名。**视觉上省掉的文字，在 tile 的 `aria-label` 里补回来**（§3.1 ③）：
 *   少了它，读屏拿到的是一个没有名字的东西。
 * - **状态先靠形状**（§4）：在跑的 = 2px 实线描边 + 实心点，没跑的 = 虚线中性描边 + 空心圈。
 *   颜色只是第二通道——两个档要是连形状都一样，状态就只剩颜色可读了。
 * - **只画已安装的 agent**（§3.1 ④）。名单来自清单本身（`source/agents.ts`），
 *   镜像还没构建的 agent 不在其中，也不该在这里被画成一个可辨认的身份。
 *
 * 面板的文案（副标题、共享区标题、拖放区那一句）逐字照 `packages/console` 现在真正
 * 显示的字：`PanelCard` 的副标题只说后果，不说术语，所以这里也没有「气闸」「凭据」「舱」。
 * 这一档画的是一个 agent 在跑，副标题就用运行中那一句；两档都写在 `i18n` 的同一个 key 里
 * 会让这张图只能对一半。
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
              {t('tray.status', '运行中 · 它拿不到你的密钥')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 px-3.5 py-3">
          {TRAY_AGENT_ROWS.map(row => {
            const running = RUNNING_IDS.includes(row.id)
            return (
              <span
                className={running ? RUNNING_TILE : IDLE_TILE}
                // `role="img"`：这是一个**画出来的**方块（真实面板里它是按钮，这张图上不是），
                // 有了它，`aria-label` 才是一个有效的名字，而不是挂在无名元素上的装饰。
                role="img"
                aria-label={`${row.label} · ${
                  running ? t('tray.stateRunning', '运行中') : t('tray.stateIdle', '未运行')
                }`}
                key={row.id}
              >
                {/* 方块上只有标记。图形资产还没有，回退到清单名字的第一个字——
                    与面板实现（`packages/console` 的 `AgentStatusRow`）同一套回退。 */}
                <span aria-hidden="true" className="text-sm font-semibold text-ink">
                  {row.label.slice(0, 1)}
                </span>
                <span
                  aria-hidden="true"
                  className={
                    running
                      ? 'absolute right-1 bottom-1 size-2 rounded-full bg-mint'
                      : 'absolute right-1 bottom-1 size-2 rounded-full border border-ink-3'
                  }
                />
              </span>
            )
          })}
        </div>

        <div className="px-3.5 pb-3">
          <p className="flex items-baseline justify-between text-xs text-ink-3">
            {t('tray.shared', '共享给全部 agent')}
            <span className="text-ink-4">
              {t('tray.sharedCount', '{{count}} 项', { count: SHARED.length })}
            </span>
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
            {t('tray.dropHint', '拖到这里 → 全部 agent 立刻可见')}
          </p>
        </div>
      </div>

      <figcaption className="mt-3 text-center text-xs text-ink-4">
        {t('tray.caption', '面板示意 · 按产品规格绘制，桌面壳仍在开发中')}
      </figcaption>
    </figure>
  )
}
