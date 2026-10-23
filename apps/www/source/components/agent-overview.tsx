import type { ReactNode } from 'react'
import { BadgeCheck, CircleQuestionMark } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AGENT_ROWS, type AgentRow } from '../agents'
import { SectionHeading } from './section-heading'

/**
 * Agent 一览。
 *
 * 这一节的每一个值都来自 `source/agents.ts`（它又直接读
 * `packages/contracts/source/agents.ts` 的清单），页面上没有一份手抄的 agent 数据。
 * 清单改了，这里跟着改 —— 包括「镜像还没构建」「命令名还没核对」这种「不好看但真实」
 * 的状态：它们正是这一节最该说清楚的东西。
 *
 * 与手册的分工：这里只回答「abx 怎么把这三个 agent 接起来」，不写怎么装、怎么配置。
 */
export const AgentOverview = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="agents-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="agents"
    >
      <SectionHeading
        eyebrow={t('agents.eyebrow', 'Agent 一览')}
        id="agents-title"
        lead={t(
          'agents.lead',
          'abx 不把 agent 写死在代码里：一个 agent 就是一条清单。下面这三张卡片读的就是那份清单本身，不是它的副本。',
        )}
        title={t('agents.title', '三个 agent，各一条清单')}
      />

      <ul className="mt-12 grid gap-4 lg:grid-cols-3">
        {AGENT_ROWS.map(row => (
          <li key={row.id}>
            <AgentCard row={row} />
          </li>
        ))}
      </ul>

      <div className="mt-6 grid gap-4 rounded-xl border border-line bg-surface-1/50 p-6 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink-2">
            {t('agents.caveatTitle', '这一节里三个「还没有」')}
          </h3>
          <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-ink-3">
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-ink-4" />
              {t(
                'agents.caveatImage',
                '镜像：有的 agent 还没构建镜像，那一格显示「尚未构建」，而不是拼一个假版本号。镜像构建好之后会自动变成「仓库:版本」。',
              )}
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-ink-4" />
              {t(
                'agents.caveatHistory',
                '历史目录：写的是每个 agent 把历史与会话写进去的地方。按舱持久化还在实现中 —— 在它落地之前，容器一销毁，这些目录不会保留。',
              )}
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-ink-4" />
              {t(
                'agents.caveatStatus',
                '核实状态：标「待核对」的那条，命令名与配置字段名都还没有权威来源，用之前请自己确认一次。',
              )}
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-medium text-ink-2">
            {t('agents.upstreamTitle', '上游那一列是什么')}
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-ink-3">
            {t(
              'agents.upstreamBody',
              '它是这条清单里的默认上游，不是你能用到的全部。真正决定请求去哪的是舱外 OSW 上的渠道配置：密钥、路由、故障转移都在那边，舱内看不到，也不需要知道。',
            )}
          </p>
        </div>
      </div>
    </section>
  )
}

type AgentCardProps = { row: AgentRow }

const AgentCard = (props: AgentCardProps) => {
  const { row } = props
  const { t } = useTranslation()
  const verified = row.status === 'stable'

  return (
    <article className="flex h-full flex-col rounded-xl border border-line bg-surface-0 p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium text-ink">{row.label}</h3>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs ${
            verified ? 'text-ink-3' : 'text-amber'
          }`}
        >
          {verified ? (
            <BadgeCheck aria-hidden="true" className="size-3.5" />
          ) : (
            <CircleQuestionMark aria-hidden="true" className="size-3.5" />
          )}
          {verified
            ? t('agents.statusStable', '已核对')
            : t('agents.statusUnconfirmed', '待核对')}
        </span>
      </div>

      <dl className="mt-5 grid gap-4 text-sm">
        <Row label={t('agents.fieldCommand', '舱内命令')}>
          <code className="font-mono text-ink-2">{row.command}</code>
        </Row>
        <Row label={t('agents.fieldUpstream', '默认上游')}>
          <code className="font-mono text-ink-2">{row.upstreamId}</code>
        </Row>
        <Row label={t('agents.fieldEnv', '舱内变量')}>
          <code className="block font-mono text-xs leading-6 text-ink-2">
            {row.baseUrlEnv}
            <br />
            {row.tokenEnv}
          </code>
        </Row>
        <Row label={t('agents.fieldPlaceholder', '舱内占位符')}>
          <code className="font-mono text-xs text-amber">{row.placeholderToken}</code>
        </Row>
        <Row label={t('agents.fieldCellToken', '舱令牌怎么走')}>
          {row.cellTokenVia === 'header'
            ? t('agents.cellTokenHeader', '请求头（不会出现在 URL 与日志里）')
            : t('agents.cellTokenPath', 'URL 路径前缀（这个 agent 加不了自定义请求头）')}
        </Row>
        <Row label={t('agents.fieldConfig', '舱内配置文件')}>
          <span className="grid gap-1">
            {row.configFiles.map(file => (
              <span className="flex flex-wrap items-baseline gap-x-2" key={file.path}>
                <code className="font-mono text-xs text-ink-2">{file.path}</code>
                <span className="text-xs text-ink-4">
                  {file.generated
                    ? t('agents.configGenerated', 'abx 生成，只读挂入')
                    : t('agents.configRegistered', '只登记，不生成也不挂载')}
                </span>
              </span>
            ))}
          </span>
        </Row>
        <Row label={t('agents.fieldHistory', '历史写在哪')}>
          <span className="flex flex-wrap gap-x-2 gap-y-1">
            {row.statePaths.length === 0 ? (
              <span className="text-ink-4">{t('agents.none', '清单未声明')}</span>
            ) : (
              row.statePaths.map(path => (
                <code className="font-mono text-xs text-ink-2" key={path}>
                  {path}
                </code>
              ))
            )}
          </span>
        </Row>
        <Row label={t('agents.fieldImage', '镜像')}>
          {row.image.state === 'unbuilt' ? (
            // `unbuilt` 是清单给脚本看的哨兵值，不是版本号：这里必须说人话。
            <span className="text-ink-4">{t('agents.imageUnbuilt', '镜像尚未构建')}</span>
          ) : (
            <code className="font-mono text-xs text-ink-2">
              {row.image.repository}:{row.image.version}
            </code>
          )}
        </Row>
      </dl>
    </article>
  )
}

type RowProps = { children: ReactNode; label: string }

/** 一行「字段名 → 清单里的值」。值可能是 code、可能是多行，所以只约定标签。 */
const Row = (props: RowProps) => {
  const { children, label } = props
  return (
    <div className="grid gap-1 border-t border-line pt-3 first:border-0 first:pt-0">
      <dt className="text-xs text-ink-4">{label}</dt>
      <dd className="text-ink-3">{children}</dd>
    </div>
  )
}
