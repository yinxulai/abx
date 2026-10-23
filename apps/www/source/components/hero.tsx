import { TrayPanelPreview } from './tray-panel-preview'

const HIGHLIGHTS = ['零密钥进舱', '默认拒绝出网', '全程审计'] as const

export const Hero = () => (
  <section aria-labelledby="hero-title" className="relative mx-auto max-w-6xl px-6 pt-16 pb-20 lg:pt-24 lg:pb-28">
    <div className="grid items-center gap-14 lg:grid-cols-[1.08fr_0.92fr] lg:gap-16">
      <div className="animate-rise">
        <p className="inline-flex rounded-full border border-line bg-surface-1/60 px-3 py-1 text-xs tracking-[0.14em] text-ink-3 uppercase">
          AIRLOCK BOX · macOS 托盘应用
        </p>

        <h1
          className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl"
          id="hero-title"
        >
          给 AI coding agent 的隔离舱
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
          把仓库和资料递进一个一次性的舱，让 agent 在里面像在本机一样干活。
          它拿不到你的密钥，出不了白名单，也删不掉你的机器。
        </p>

        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-3">
          模型和密钥留在舱外的 OSW。舱里只有一个地址、一个占位符 ——
          <span className="text-ink-2">没有可泄漏的东西。</span>
        </p>

        <div className="mt-9 flex flex-wrap gap-3">
          <a
            className="inline-flex items-center gap-2 rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-void transition-colors hover:bg-white"
            href="#model"
          >
            看看舱里有什么
            <span aria-hidden="true">→</span>
          </a>
          <a
            className="inline-flex items-center rounded-md border border-line-strong px-5 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
            href="#how"
          >
            怎么用
          </a>
        </div>

        <ul className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-3">
          {HIGHLIGHTS.map(item => (
            <li className="flex items-center gap-2" key={item}>
              <span aria-hidden="true" className="size-1 rounded-full bg-ice" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <TrayPanelPreview />
    </div>
  </section>
)
