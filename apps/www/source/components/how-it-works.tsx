import { SectionHeading } from './section-heading'

const STEPS = [
  {
    title: '点开菜单栏里的 abx',
    body: '气闸随托盘一起启动。面板第一行就告诉你现在有几个舱在跑、凭据在哪。首次启动不弹配置向导，也不要求填密钥。',
  },
  {
    title: '把文件拖进共享区',
    body: '拖到托盘图标，或面板里的虚线区。已经跑起来的 agent 立刻能看见，不需要重启舱。共享区一律只读，agent 改不了你递进去的东西。',
  },
  {
    title: '起舱，把活交出去',
    body: '点一下 agent 方块就开一个新舱。任务目录可写，共享区只读，产物写回这一舱的取回区，点一下就到 Finder 里。',
  },
] as const

/** 用户旅程 J2 / J3 / J5 的对外表达：只用三句话说清「怎么用」。 */
export const HowItWorks = () => (
  <section
    aria-labelledby="how-title"
    className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
    id="how"
  >
    <SectionHeading
      eyebrow="怎么用"
      id="how-title"
      lead="没有命令行，没有配置文件。托盘就是全部的入口。"
      title="三步，把活递进去"
    />

    <ol className="mt-12 grid gap-4 md:grid-cols-3">
      {STEPS.map((step, index) => (
        <li
          className="flex flex-col rounded-xl border border-line bg-surface-0 p-6"
          key={step.title}
        >
          <span className="font-mono text-sm text-ice" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <h3 className="mt-4 text-base font-medium text-ink">{step.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">{step.body}</p>
        </li>
      ))}
    </ol>

    <p className="mt-8 max-w-3xl text-sm leading-relaxed text-ink-3">
      拖拽用的是 macOS 托盘的原生能力，所以第一版只做 macOS。
      需要「停止全部」时，停止的是舱；共享区和取回区里的文件都会留在原处，移除共享条目只解除挂载，绝不删原文件。
    </p>
  </section>
)
