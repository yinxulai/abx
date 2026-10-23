import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/**
 * 下载区暂为占位：产品还没有可发布的安装包。
 *
 * 这里刻意**不放任何 `href`、按钮或伪造的下载链接** —— 一个点不动或者点了没反应的
 * 下载按钮，比一句「还没有」更伤信任。等真有产物时再加，那时也只需要改这一处。
 *
 * 平台那一条只说结论，逐平台的说明在「边界」一节（`boundaries.tsx`）：
 * 同一个话题不在这两节里各写一遍。
 */
const FACTS = [
  { key: 'platform', label: '平台', value: 'macOS' },
  { key: 'status', label: '状态', value: '开发中' },
  { key: 'installer', label: '安装包', value: '尚未提供' },
] as const

export const DownloadSection = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="download-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="download"
    >
      <SectionHeading
        eyebrow={t('download.eyebrow', '下载')}
        id="download-title"
        lead={t(
          'download.lead',
          '托盘、气闸和沙箱仍在实现中，还没有可供下载的安装包。什么时候有，以更新日志里的那条版本为准。',
        )}
        title={t('download.title', 'macOS 版，开发中')}
      />

      <div className="mt-12 grid gap-8 rounded-2xl border border-line bg-surface-0 p-6 sm:p-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div>
          <p className="flex items-center gap-2 text-sm text-ink-3">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
            {t('download.badge', '第一版只做 macOS')}
          </p>
          <p className="mt-4 text-lg font-medium text-ink">
            {t('download.headline', '发布后，下载入口会出现在这里。')}
          </p>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-3">
            {t(
              'download.body',
              '在此之前这里不放占位链接，也不提前承诺一个日期。其它平台支持到什么程度，写在「边界」那一节里。',
            )}
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-3 rounded-xl border border-line bg-surface-1/60 p-4 text-sm">
          {FACTS.map(fact => (
            <div key={fact.key}>
              <dt className="text-xs text-ink-4">{t(`download.fact.${fact.key}`, fact.label)}</dt>
              <dd className="mt-1 text-ink-2">{t(`download.value.${fact.key}`, fact.value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
