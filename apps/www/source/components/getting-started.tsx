import { FolderInput, MousePointerClick, PackageOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/**
 * 开始使用。**三步以内**，每一步都写「你会看到什么」，不是「请先配置什么」。
 *
 * 每一步的细节都能在 `specs/product/first-experience.md` 的验收清单里找到对应条目
 * （托盘出面板、拖文件起舱、共享条目只读、取回区）；这里只给结论，不抄那份清单 ——
 * 官网回答「为什么值得用、上手是什么样」，手册回答「每一条怎么验」。
 *
 * 第一步如实写着**还没有安装包**：这一节最容易写成一句「点这里下载」，
 * 而产品还没有可下载的东西，先写清楚比事后改口径便宜。
 */
const STEPS = [
  {
    key: 'install',
    icon: <PackageOpen aria-hidden="true" className="size-5" />,
    title: '装好它',
    body: '安装包还没发布。发布后是一个 .dmg：拖进「应用程序」就行。签名是 ad-hoc、没有公证，所以第一次打开会被 Gatekeeper 拦一下，需要在「隐私与安全性」里放行 —— 这一步以后会被签名替代。',
  },
  {
    key: 'firstRun',
    icon: <MousePointerClick aria-hidden="true" className="size-5" />,
    title: '第一次打开',
    body: '菜单栏出现一个 abx 图标，Dock 里没有图标。点开面板，第一行就写着现在有几个舱在跑、凭据在哪。不弹配置向导，不要求填密钥 —— 密钥在舱外的 OSW 里，这里没有可填的地方。',
  },
  {
    key: 'drop',
    icon: <FolderInput aria-hidden="true" className="size-5" />,
    title: '拖一个目录进去',
    body: '拖到菜单栏图标，或面板里的虚线区。它变成一条共享条目：舱里的 agent 立刻能读到，只读。起舱后它在那个目录里干活，产物写进这一舱自己的取回区，点一下就到访达里。',
  },
] as const

export const GettingStarted = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="start-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="start"
    >
      <SectionHeading
        eyebrow={t('start.eyebrow', '开始使用')}
        id="start-title"
        lead={t('start.lead', '没有命令行，没有配置文件，也没有要填的密钥。托盘就是全部的入口。')}
        title={t('start.title', '三步，把活递进去')}
      />

      <ol className="mt-12 grid gap-4 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li className="flex flex-col rounded-xl border border-line bg-surface-0 p-6" key={step.key}>
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-sm text-ice" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface-1 text-ice">
                {step.icon}
              </span>
            </div>
            <h3 className="mt-4 text-base font-medium text-ink">
              {t(`start.step.${step.key}.title`, step.title)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              {t(`start.step.${step.key}.body`, step.body)}
            </p>
          </li>
        ))}
      </ol>

      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-ink-3">
        {t(
          'start.note',
          '拖拽用的是 macOS 菜单栏的原生能力，所以第一版只做 macOS。需要停的时候，「停止全部」停的是舱：共享条目和取回区里的文件都留在原处，移除一条共享只解除挂载，不删你的原文件。',
        )}
      </p>
    </section>
  )
}
