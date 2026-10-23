import { Boxes, FileCheck2, Lock, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/**
 * 边界与不承诺。
 *
 * 这一节存在的理由：官网前面几节讲的都是「它挡住什么」，如果只有那些，
 * 读者会自己把「挡住什么」外推成「挡住一切」。所以这里把**不挡的**也说清楚：
 * 明确不承诺什么、哪个平台到了什么程度、什么情况下这东西根本不该用。
 *
 * 事实来源：`specs/overview/design.md` §5（后端矩阵、`local` 后端不是沙箱）、
 * `specs/product/functional-design.md`（V1 不做 Linux/Windows 桌面版）、
 * `specs/roadmap.md` §四（明确未验证清单）。这里不写规格之外的承诺。
 */
const BOUNDARIES = [
  {
    key: 'egress',
    icon: <ShieldOff aria-hidden="true" className="size-5" />,
    title: '默认拒绝出口',
    body: '出网按域名白名单放行。白名单之外的请求一律拦下并留痕 —— 默认值就是最紧的那一档，不需要你再去收紧。',
  },
  {
    key: 'shared',
    icon: <Lock aria-hidden="true" className="size-5" />,
    title: '共享区只读',
    body: '你递进去的每一样东西都是只读挂载。agent 能读，改不了；需要它产出时，写进这一舱单独的取回区。',
  },
  {
    key: 'audit',
    icon: <FileCheck2 aria-hidden="true" className="size-5" />,
    title: '审计留痕',
    body: '每次出网一行记录：时间、舱、目标域名、放行或拒绝、状态码、耗时。密钥那一列只有「已注入 / 未注入」，永远没有值本身。',
  },
  {
    key: 'disposable',
    icon: <Boxes aria-hidden="true" className="size-5" />,
    title: '一次性的舱',
    body: '舱退出即销毁。不写启动项、不留后台进程，改动也只有任务目录和取回区留得下。',
  },
] as const

const NON_PROMISES = [
  {
    key: 'kernel',
    text: '不承诺防住内核级逃逸 —— 共用内核，容器不是虚拟机。',
  },
  {
    key: 'selfInflicted',
    text: '不承诺防住你主动把凭据拖进共享区 —— 闸门拦的是 agent 拿不到，不是你递过去。',
  },
  {
    key: 'anonymity',
    text: '不承诺网络侧匿名 —— 出网 IP 仍然是你自己的。',
  },
  {
    key: 'adversarial',
    text: '不承诺已经扛住对抗性攻击 —— 现有证据来自「正常使用下它是对的」，还没有人试过绕过白名单或伪造舱令牌。',
  },
  {
    key: 'taskDir',
    text: '不承诺任务目录里的改动可回滚 —— 那是一个可写的真实目录，agent 在里面删掉的东西不会自己回来。',
  },
] as const

const PLATFORMS = [
  {
    key: 'macos',
    platform: 'macOS',
    support: 'V1 目标平台',
    detail:
      '托盘、拖拽、App Sandbox 都是 macOS 语义，所以第一版只做它。当前状态是开发中，且尚未在 macOS 真机上验证。',
  },
  {
    key: 'linux',
    platform: 'Linux',
    support: '仅开发期',
    detail:
      '只用来跑通逻辑的 `local` 后端。它不隔离任何东西，产品里显式标注「不是沙箱，禁止用于演示」，也不做桌面版。',
  },
  {
    key: 'windows',
    platform: 'Windows',
    support: '不做',
    detail: '没有排期。设计里预留的后端是 Windows Sandbox，但 V1 明确不含 Windows 桌面版。',
  },
] as const

const UNSUITABLE = [
  {
    key: 'guiApp',
    text: '要测的东西得弹出窗口、点菜单才跑得起来 —— 舱里没有图形界面。',
  },
  {
    key: 'kernelWork',
    text: '要跑内核模块、改系统设置，或者需要比容器更硬的隔离 —— 该用虚拟机。',
  },
  {
    key: 'dockerInDocker',
    text: '任务本身要再起容器 —— 舱里没有 docker socket，这是刻意的。',
  },
  {
    key: 'wholeMachine',
    text: '希望 agent 直接读你整台机器的任意路径 —— 只有你挂进去的目录它才看得见。',
  },
  {
    key: 'longLived',
    text: '要一个长期驻留、跨会话保留全部状态的开发环境 —— 舱是一次性的。',
  },
] as const

export const Boundaries = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="boundaries-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="boundaries"
    >
      <SectionHeading
        eyebrow={t('boundaries.eyebrow', '安全边界')}
        id="boundaries-title"
        lead={t(
          'boundaries.lead',
          '白名单、只读、审计都是默认值，不是设置项。一个默认全开、等你手动收紧的沙箱，在真实使用里等于没有沙箱。',
        )}
        title={t('boundaries.title', '默认安全，不靠你配置')}
      />

      <ul className="mt-12 grid gap-4 sm:grid-cols-2">
        {BOUNDARIES.map(boundary => (
          <li className="rounded-xl border border-line bg-surface-0 p-6" key={boundary.key}>
            <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface-1 text-ice">
              {boundary.icon}
            </span>
            <h3 className="mt-4 text-base font-medium text-ink">
              {t(`boundaries.item.${boundary.key}.title`, boundary.title)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              {t(`boundaries.item.${boundary.key}.body`, boundary.body)}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-6 rounded-xl border border-line bg-surface-1/50 p-6">
        <h3 className="text-sm font-medium text-ink-2">
          {t('boundaries.nonPromiseTitle', '明确不承诺什么')}
        </h3>
        <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-ink-3">
          {NON_PROMISES.map(item => (
            <li className="flex gap-2" key={item.key}>
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-ink-4" />
              {t(`boundaries.nonPromise.${item.key}`, item.text)}
            </li>
          ))}
        </ul>
      </div>

      <h3 className="mt-14 text-sm font-medium text-ink-3">
        {t('boundaries.platformTitle', '各平台支持到什么程度')}
      </h3>
      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            {t('boundaries.platformCaption', '三个平台的桌面版支持程度与原因')}
          </caption>
          <thead>
            <tr className="border-b border-line bg-surface-1 text-xs text-ink-3">
              <th className="px-4 py-3 font-medium" scope="col">
                {t('boundaries.platformColumn', '平台')}
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                {t('boundaries.supportColumn', '支持程度')}
              </th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell" scope="col">
                {t('boundaries.whyColumn', '说明')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {PLATFORMS.map(item => (
              <tr key={item.key}>
                <th className="px-4 py-3 align-top font-medium text-ink" scope="row">
                  {item.platform}
                </th>
                <td className="px-4 py-3 align-top text-ink-2">
                  {t(`boundaries.platform.${item.key}.support`, item.support)}
                  <span className="mt-1 block text-xs text-ink-4 sm:hidden">
                    {t(`boundaries.platform.${item.key}.detail`, item.detail)}
                  </span>
                </td>
                <td className="hidden px-4 py-3 align-top text-ink-3 sm:table-cell">
                  {t(`boundaries.platform.${item.key}.detail`, item.detail)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-14 text-sm font-medium text-ink-3">
        {t('boundaries.unsuitableTitle', '什么情况下不适用')}
      </h3>
      <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-ink-3 sm:grid-cols-2">
        {UNSUITABLE.map(item => (
          <li className="flex gap-2" key={item.key}>
            <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-ink-4" />
            {t(`boundaries.unsuitable.${item.key}`, item.text)}
          </li>
        ))}
      </ul>
    </section>
  )
}
