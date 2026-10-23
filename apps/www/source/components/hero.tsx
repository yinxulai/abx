import type { ReactNode } from 'react'
import { Ban, KeyRound, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TrayPanelPreview } from './tray-panel-preview'

/**
 * 首屏。左文右图：左边是「一句话承诺 + 两个动作 + 三条硬性质」，
 * 右边是托盘面板示意。承诺里出现的每一条性质，页面上后面都有一节展开讲。
 */
export const Hero = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="hero-title"
      className="relative mx-auto max-w-6xl px-6 pt-16 pb-20 lg:pt-24 lg:pb-28"
    >
      <div className="grid items-center gap-14 lg:grid-cols-[1.08fr_0.92fr] lg:gap-16">
        <div className="animate-rise">
          <p className="inline-flex rounded-full border border-line bg-surface-1/60 px-3 py-1 text-xs tracking-[0.14em] text-ink-3">
            {t('hero.badge', 'AIRLOCK BOX · macOS 托盘应用')}
          </p>

          <h1
            className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl"
            id="hero-title"
          >
            {t('hero.title', '给 AI coding agent 的隔离舱')}
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
            {t(
              'hero.lead',
              '把仓库和资料递进一个一次性的舱，让 agent 在里面像在本机一样干活。它拿不到你的密钥，出不了白名单，也删不掉你的机器。',
            )}
          </p>

          <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-3">
            {t(
              'hero.sub',
              '模型和密钥留在舱外的 OSW。舱里只有一个地址、一个占位符 —— ',
            )}
            <span className="text-ink-2">{t('hero.subAccent', '没有可泄漏的东西。')}</span>
          </p>

          <div className="mt-9 flex flex-wrap gap-3">
            <a
              className="inline-flex min-h-11 items-center gap-2 rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-void transition-colors hover:bg-ink/85"
              href="#model"
            >
              {t('hero.primary', '看看舱里有什么')}
              <span aria-hidden="true">→</span>
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-md border border-line-strong px-5 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
              href="#start"
            >
              {t('hero.secondary', '开始使用')}
            </a>
          </div>

          <ul className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-ink-3">
            <Highlight icon={<KeyRound aria-hidden="true" className="size-4 text-ice" />}>
              {t('hero.highlightKeys', '零密钥进舱')}
            </Highlight>
            <Highlight icon={<Ban aria-hidden="true" className="size-4 text-ice" />}>
              {t('hero.highlightEgress', '默认拒绝出网')}
            </Highlight>
            <Highlight icon={<ScrollText aria-hidden="true" className="size-4 text-ice" />}>
              {t('hero.highlightAudit', '全程审计')}
            </Highlight>
          </ul>
        </div>

        <TrayPanelPreview />
      </div>
    </section>
  )
}

type HighlightProps = { children: string; icon: ReactNode }

const Highlight = (props: HighlightProps) => {
  const { children, icon } = props
  return (
    <li className="flex items-center gap-2">
      {icon}
      {children}
    </li>
  )
}
