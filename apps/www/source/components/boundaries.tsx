import type { ReactNode } from 'react'
import { SectionHeading } from './section-heading'

type Boundary = {
  body: string
  icon: ReactNode
  title: string
}

const BOUNDARIES: Boundary[] = [
  {
    title: '默认拒绝出口',
    body: '出网按域名白名单放行。白名单之外的请求一律拦下并留痕 —— 默认值就是最紧的那一档，不需要你再去收紧。',
    icon: (
      <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 15 15 5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    title: '共享区只读',
    body: '你递进去的每一样东西都是只读挂载。agent 能读，改不了；需要它产出时，写进这一舱单独的取回区。',
    icon: (
      <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 20 20">
        <rect height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" width="12" x="4" y="9" />
        <path
          d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    ),
  },
  {
    title: '审计留痕',
    body: '每次出网一行记录：时间、舱、目标域名、放行或拒绝、状态码、耗时。密钥那一列只有「已注入 / 未注入」，永远没有值本身。',
    icon: (
      <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 20 20">
        <rect height="14" rx="2" stroke="currentColor" strokeWidth="1.5" width="12" x="4" y="3" />
        <path
          d="M7 7h6M7 10h6M7 13h3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    ),
  },
  {
    title: '一次性的舱',
    body: '舱退出即销毁。不写启动项、不留后台进程，改动也只有任务目录和取回区留得下。',
    icon: (
      <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 20 20">
        <path
          d="M10 2.5v7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
        <path
          d="M5.5 5.5a7 7 0 1 0 9 0"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    ),
  },
]

const NON_PROMISES = [
  '不承诺防住内核级逃逸 —— 共用内核，容器不是虚拟机。',
  '不承诺防住你主动把凭据拖进共享区。',
  '不承诺网络侧完全匿名 —— 出网 IP 仍然是你自己的。',
] as const

export const Boundaries = () => (
  <section
    aria-labelledby="boundaries-title"
    className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
    id="boundaries"
  >
    <SectionHeading
      eyebrow="安全边界"
      id="boundaries-title"
      lead="白名单、只读、审计都是默认值，不是设置项。一个默认全开、等你手动收紧的沙箱，在真实使用里等于没有沙箱。"
      title="默认安全，不靠你配置"
    />

    <ul className="mt-12 grid gap-4 sm:grid-cols-2">
      {BOUNDARIES.map(boundary => (
        <li
          className="rounded-xl border border-line bg-surface-0 p-6"
          key={boundary.title}
        >
          <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface-1 text-ice">
            {boundary.icon}
          </span>
          <h3 className="mt-4 text-base font-medium text-ink">{boundary.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">{boundary.body}</p>
        </li>
      ))}
    </ul>

    <div className="mt-6 rounded-xl border border-line bg-surface-1/50 p-6">
      <h3 className="text-sm font-medium text-ink-2">明确不承诺什么</h3>
      <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-ink-3 sm:grid-cols-3">
        {NON_PROMISES.map(item => (
          <li className="flex gap-2" key={item}>
            <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-ink-4" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  </section>
)
