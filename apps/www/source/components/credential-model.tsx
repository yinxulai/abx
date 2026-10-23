import { Ban, CircleSlash, KeyRound, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/** 四条性质。`key` 同时是 i18n key 的后缀：`model.principle.<key>.{title,body}`。 */
const PRINCIPLES = [
  { key: 'host', icon: <KeyRound aria-hidden="true" className="size-5" /> },
  { key: 'placeholder', icon: <CircleSlash aria-hidden="true" className="size-5" /> },
  { key: 'egress', icon: <Ban aria-hidden="true" className="size-5" /> },
  { key: 'audit', icon: <ScrollText aria-hidden="true" className="size-5" /> },
] as const

type PrincipleKey = (typeof PRINCIPLES)[number]['key']

/** 同样：`model.question.<key>.{q,a}`。 */
const QUESTIONS = ['baseUrl', 'sibling', 'audit'] as const

type QuestionKey = (typeof QUESTIONS)[number]

const HOLDERS = [
  { holder: 'OSW（宿主）', holds: '供应商、密钥、模型路由、故障转移' },
  { holder: 'abx 气闸（宿主）', holds: '舱令牌校验、出口白名单、凭据替换、审计' },
  { holder: '舱内 agent', holds: '一个 baseUrl，一个占位符。别的什么都没有' },
] as const

/**
 * 凭据模型 —— 产品的立身之本，所以这一节讲机制，不停在口号上：
 * 密钥在哪、占位符为什么无害、出口为什么默认拒绝、留痕留的是什么。
 *
 * 口径来自 `specs/README.md`「与 OSW 的关系」与 `functional-design.md` §7.1，
 * 不添加规格之外的机制：这里写的每一条都能在 core 里找到对应的实现或测试。
 */
export const CredentialModel = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="model-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="model"
    >
      <SectionHeading
        eyebrow={t('model.eyebrow', '凭据模型')}
        id="model-title"
        lead={t(
          'model.lead',
          'abx 的安全不靠「把密钥藏得深」，靠的是舱内不存在一把真密钥。下面四条一起成立，缺一条这个结论就不成立。',
        )}
        title={t('model.title', '密钥不进舱，这不是配置出来的')}
      />

      <ul className="mt-12 grid gap-4 sm:grid-cols-2">
        {PRINCIPLES.map(principle => (
          <li className="rounded-xl border border-line bg-surface-0 p-6" key={principle.key}>
            <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface-1 text-ice">
              {principle.icon}
            </span>
            <h3 className="mt-4 text-base font-medium text-ink">
              {t(`model.principle.${principle.key}.title`, PRINCIPLE_FALLBACK[principle.key].title)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              {t(`model.principle.${principle.key}.body`, PRINCIPLE_FALLBACK[principle.key].body)}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-14 grid gap-10 lg:grid-cols-2 lg:gap-14">
        <div className="space-y-5 text-base leading-relaxed text-ink-2">
          <p>
            {t(
              'model.body1',
              '模型和密钥都配置在宿主上的 OSW —— 它已经把你手上的渠道收进一个本地地址。abx 不复制任何供应商配置，也不把密钥带进舱里。',
            )}
          </p>
          <p>
            {t(
              'model.body2',
              '舱内 agent 那一侧看到的全部，就是右边这些：一个自定义供应商、一个 baseUrl、一个无条件会被气闸替换掉的占位符 token。没有供应商列表，没有模型清单，没有账户，也没有第二把密钥。',
            )}
          </p>
          <blockquote className="border-l-2 border-ice/60 pl-4 text-lg leading-relaxed text-ink">
            {t('model.quote', '藏起来的东西会被找到；')}
            <span className="text-ice">{t('model.quoteAccent', '不存在的东西不会。')}</span>
          </blockquote>
        </div>

        <CodeSample />
      </div>

      <h3 className="mt-16 text-sm font-medium text-ink-3">{t('model.whoTitle', '谁拿着什么')}</h3>
      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            {t('model.tableCaption', 'OSW、气闸与舱内 agent 各自持有的东西')}
          </caption>
          <thead>
            <tr className="border-b border-line bg-surface-1 text-xs text-ink-3">
              <th className="px-4 py-3 font-medium" scope="col">
                {t('model.who', '谁')}
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                {t('model.holds', '拿什么')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {HOLDERS.map(item => (
              <tr key={item.holder}>
                <th className="px-4 py-3 font-medium text-ink" scope="row">
                  {item.holder}
                </th>
                <td className="px-4 py-3 text-ink-2">{item.holds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-14 text-sm font-medium text-ink-3">
        {t('model.questionsTitle', '三个会被问到的点')}
      </h3>
      <ul className="mt-4 grid gap-4 lg:grid-cols-3">
        {QUESTIONS.map(key => (
          <li className="rounded-xl border border-line bg-surface-1/50 p-6" key={key}>
            <p className="text-sm font-medium text-ink-2">
              {t(`model.question.${key}.q`, QUESTION_FALLBACK[key].q)}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              {t(`model.question.${key}.a`, QUESTION_FALLBACK[key].a)}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-ink-4">
        {t(
          'model.footnote',
          '气闸是舱的前门，OSW 是门后的调度中心：舱面上只暴露一个地址，它指向气闸，气闸再把请求交给 OSW —— 不需要修改 OSW。',
        )}
      </p>
    </section>
  )
}

/** 舱内配置的样子。是「示意」，不是某个真实会话的抓图。 */
const CodeSample = () => {
  const { t } = useTranslation()

  return (
    <div className="h-fit rounded-xl border border-line bg-surface-0 lg:self-start">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <p className="text-xs text-ink-3">
          {t('model.sampleTitle', '舱内 agent 看到的全部配置')}
        </p>
        <span className="shrink-0 rounded border border-line px-1.5 py-1 text-xs text-ink-4">
          {t('model.sampleBadge', '示意')}
        </span>
      </div>
      <pre className="px-4 py-5 font-mono text-xs leading-7 break-words whitespace-pre-wrap text-ink-2">
        <code>
          <span className="text-ink-3">provider</span>
          {': '}
          <span className="text-ink">custom</span>
          {'\n'}
          <span className="text-ink-3">baseUrl </span>
          {': '}
          <span className="text-ink">{'http://<气闸舱面>/c/<舱令牌>/u/osw'}</span>
          {'\n'}
          <span className="text-ink-3">apiKey  </span>
          {': '}
          <span className="text-amber">{'***'}</span>
          {'   '}
          <span className="text-ink-4">{t('model.sampleComment', '// 无条件被替换的占位符')}</span>
        </code>
      </pre>
    </div>
  )
}

/**
 * 中文兜底与 i18n key 放在一起。
 *
 * 之所以不把这些文案直接写在 JSX 里：这一节的条目是**数据表驱动**的，
 * `i18n.test.ts` 靠正则扫不到 `t(variable, ...)` 的 key，所以在这里显式登记一份，
 * 英文表缺哪一条会当场报出来。
 */
const PRINCIPLE_FALLBACK: Record<PrincipleKey, { body: string; title: string }> = {
  host: {
    title: '密钥留在舱外的宿主',
    body: '供应商、密钥、模型路由都配在宿主上的 OSW 里。abx 不复制供应商配置，也不把任何凭据写进舱——舱内的环境变量里没有真密钥，这一条有测试守着。',
  },
  placeholder: {
    title: '舱里只有一个占位符',
    body: 'agent 手里的 apiKey 是一个假 token，气闸在转发时无条件把它换掉。所以它被打印出来、写进 commit、贴给别人，都不产生任何后果。',
  },
  egress: {
    title: '出口默认拒绝',
    body: '出网按域名白名单放行。没列进去的域名一律拦下，并记一条「拒绝」的审计——默认值就是最紧的那一档，不需要你再去收紧。',
  },
  audit: {
    title: '所有进出留痕',
    body: '每次转发一行记录：时间、舱、目标域名、放行或拒绝、状态码、耗时。密钥那一列只有「已注入 / 未注入」，永远没有值本身。',
  },
} as const

const QUESTION_FALLBACK: Record<QuestionKey, { a: string; q: string }> = {
  baseUrl: {
    q: 'baseUrl 都指过去了，不就等于把密钥交出去了？',
    a: '气闸认的是舱令牌，不是那个占位符。舱令牌一次一换，随舱销毁立刻失效——拿旧令牌再请求就是 401。',
  },
  sibling: {
    q: 'agent 会不会顺手读到隔壁的凭据文件？',
    a: '不会：只挂 abx 自己生成的那一个配置文件。同目录的 .credentials.json、auth.json 这类文件有单独的规则拦着，报错也会说清「这是凭据文件」。文件在舱里根本不存在，不是权限不足。',
  },
  audit: {
    q: '审计里会不会漏出密钥？',
    a: '不会：那一列只有「已注入 / 未注入」。密钥只存在于气闸的内存里，转发那一刻注入，之后不留。',
  },
} as const
