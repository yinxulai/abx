import { SectionHeading } from './section-heading'

const RESPONSIBILITIES = [
  { holder: 'OSW（宿主）', holds: '供应商、密钥、模型路由、故障转移' },
  { holder: 'abx 气闸（宿主）', holds: '舱令牌校验、出口白名单、凭据替换、审计' },
  { holder: '舱内 agent', holds: '一个 baseUrl，一个占位符。别的什么都没有' },
] as const

/**
 * 产品的核心叙事：安全不是「把密钥藏好」，而是舱内不存在真密钥。
 * 按 `specs/README.md`「与 OSW 的关系」与 `functional-design.md` §7.1 的口径写，
 * 不添加规格之外的机制。
 */
export const CredentialModel = () => (
  <section
    aria-labelledby="model-title"
    className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
    id="model"
  >
    <SectionHeading
      eyebrow="核心叙事"
      id="model-title"
      lead="不是我们把密钥藏得很深 —— 是舱内压根不存在一把真密钥。"
      title="舱里没有可泄漏的东西"
    />

    <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-14">
      <div className="space-y-5 text-base leading-relaxed text-ink-2">
        <p>
          模型和密钥都配置在宿主上的 <span className="text-ink">OSW</span> ——
          它已经把你手上的渠道收进一个本地地址。abx
          不复制任何供应商配置，也不把密钥带进舱里。
        </p>
        <p>
          舱内 agent 那一侧看到的全部，就是右边这些：一个自定义供应商、一个
          baseUrl、一个无条件会被气闸替换掉的占位符 token。没有供应商列表，
          没有模型清单，没有账户，也没有第二把密钥。
        </p>
        <p>
          所以这个 token 被打印出来、写进 commit、发给别人，都没有任何用。
          气闸只认舱令牌，并在转发请求时注入真密钥。
        </p>
        <blockquote className="border-l-2 border-ice/60 pl-4 text-lg leading-relaxed text-ink">
          藏起来的东西会被找到；
          <span className="text-ice">不存在的东西不会。</span>
        </blockquote>
      </div>

      <div className="rounded-xl border border-line bg-surface-0">
        <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
          <p className="text-xs text-ink-3">舱内 agent 看到的全部配置</p>
          <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-4">
            示意
          </span>
        </div>
        <pre className="overflow-x-auto px-4 py-5 font-mono text-[13px] leading-7 text-ink-2">
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
            <span className="text-ink-4">{'// 无条件被替换的占位符'}</span>
          </code>
        </pre>
      </div>
    </div>

    <h3 className="mt-16 text-sm font-medium text-ink-3">谁拿着什么</h3>
    <div className="mt-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <caption className="sr-only">OSW、气闸与舱内 agent 各自持有的东西</caption>
        <thead>
          <tr className="border-b border-line bg-surface-1 text-xs text-ink-3">
            <th className="px-4 py-2.5 font-medium" scope="col">谁</th>
            <th className="px-4 py-2.5 font-medium" scope="col">拿什么</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {RESPONSIBILITIES.map(item => (
            <tr key={item.holder}>
              <th className="px-4 py-3 font-medium whitespace-nowrap text-ink" scope="row">
                {item.holder}
              </th>
              <td className="px-4 py-3 text-ink-2">{item.holds}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-3">
      气闸是舱的前门，OSW 是门后的调度中心。舱面上只暴露一个地址，它指向气闸，
      气闸再把请求交给 OSW —— 不需要修改 OSW。
    </p>
  </section>
)
