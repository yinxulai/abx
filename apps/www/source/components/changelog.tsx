import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/**
 * 更新日志。
 *
 * **只记发布过的东西**，一个月一条的进度流水不在这里：`specs/roadmap.md` 是进度的
 * 唯一来源，官网再维护一份「做到哪一步」必然与它漂移。所以现在这里只有一条
 * 「未发布」，写的是首个版本的**既定范围**（来自 `specs/product/functional-design.md`
 * 的 V1 清单），不是成绩单 —— 并且明说它是范围不是成绩。
 *
 * 发布之后这一节的形状不变：加一条版本，旧的留在下面。
 */
const RELEASES = [
  {
    key: 'first',
    version: '0.1.0',
    status: '未发布',
    title: '第一个版本打算包含什么',
    items: [
      { key: 'tray', text: '菜单栏应用：点图标出面板，把文件或目录拖进去' },
      { key: 'airlock', text: '气闸：舱令牌、出口白名单、凭据替换、审计流水' },
      { key: 'agents', text: '三个 agent（claude / codex / dsh）的最小配置生成' },
      { key: 'cells', text: '起舱与销毁：共享条目只读挂载，产物写进取回区' },
    ],
  },
] as const

export const Changelog = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="changelog-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="changelog"
    >
      <SectionHeading
        eyebrow={t('changelog.eyebrow', '更新日志')}
        id="changelog-title"
        lead={t(
          'changelog.lead',
          '这里只在真的发布时加一行。现在还没有发布过任何版本，所以只有一条「未发布」。',
        )}
        title={t('changelog.title', '只记发布过的东西')}
      />

      <ol className="mt-12 space-y-4">
        {RELEASES.map(release => (
          <li className="rounded-xl border border-line bg-surface-0 p-6" key={release.key}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-ink">{release.version}</span>
              <span className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-3">
                {t(`changelog.release.${release.key}.status`, release.status)}
              </span>
            </div>

            <h3 className="mt-4 text-base font-medium text-ink">
              {t(`changelog.release.${release.key}.title`, release.title)}
            </h3>
            <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-ink-3 sm:grid-cols-2">
              {release.items.map(item => (
                <li className="flex gap-2" key={item.key}>
                  <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-ink-4" />
                  {t(`changelog.release.${release.key}.item.${item.key}`, item.text)}
                </li>
              ))}
            </ul>

            <p className="mt-4 text-sm leading-relaxed text-ink-4">
              {t(
                `changelog.release.${release.key}.caveat`,
                '这是范围，不是成绩单：上面这些还没有全部做完，做到哪一步以项目内部路线图为准。',
              )}
            </p>
          </li>
        ))}
      </ol>

      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-ink-4">
        {t(
          'changelog.note',
          '官网不重复维护第二份进度：逐条实现到什么程度写在项目内部的路线图里，两份进度表一定会漂移。这里只回答「发布了什么」。',
        )}
      </p>
    </section>
  )
}
