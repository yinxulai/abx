import { useTranslation } from 'react-i18next'
import { SectionHeading } from './section-heading'

/**
 * 常问的问题。
 *
 * 收录标准：**读者在决定用不用之前一定会问、而前面几节没有正面回答的**。
 * 每一问的答案都收敛到「结论」，需要步骤的部分留给 `apps/docs` 的手册 ——
 * 官网把结论讲清楚，手册把每一步讲清楚，两边不互相抄。
 *
 * 答案全部来自 `specs/product/functional-design.md`（V1 范围与「明确不做」）、
 * `specs/overview/design.md` §5（后端矩阵）与 `specs/roadmap.md` §四（未验证清单）。
 * 这里没有一条是「大概会这样」。
 */
const ITEMS = [
  {
    key: 'vsLocal',
    q: '这跟直接在本机跑 agent 有什么区别？',
    a: '在本机跑，agent 用的是你的用户身份：你的 ~/.ssh、你的照片库、你的整个磁盘它都够得着。舱里它只看得见你递进去的那几个目录，出口按域名白名单放行，每一次出网都留一行记录。',
  },
  {
    key: 'keysReally',
    q: '密钥真的不会进舱吗？',
    a: '不会。舱内的环境变量里没有真密钥，agent 拿到的配置文件里只有一个占位符；密钥留在宿主的气闸进程内存里，转发那一刻才注入，之后不落盘。这一条有测试守着，不是文档里的承诺。',
  },
  {
    key: 'isSandbox',
    q: '这算沙箱吗？和虚拟机比呢？',
    a: '容器级隔离：共用宿主内核，只是看不见、出不去、删不掉别的东西。所以不承诺防住内核级逃逸 —— 需要那种强度的隔离时该用虚拟机，而不是把容器说得像虚拟机。',
  },
  {
    key: 'macOnly',
    q: '为什么只支持 macOS？',
    a: '托盘图标收文件、面板拖放这两件事用的是 macOS 的既有语义，换平台要重做一遍交互。Linux 上只有开发期用来跑通逻辑的 local 后端，它不隔离任何东西，产品里写着「不是沙箱，禁止用于演示」。',
  },
  {
    key: 'oswChange',
    q: '需要改我现在的 OSW 配置吗？',
    a: '不需要。气闸是舱的前门：舱内只有一个指向气闸的地址，气闸再把请求交给 OSW。渠道、密钥、模型路由、故障转移都还是你在 OSW 里配的那一套。',
  },
  {
    key: 'allowlist',
    q: '白名单不够用怎么办？',
    a: '被拦的域名会连着状态码记进审计，你能看到 agent 到底想连哪 —— 而不是只看到「它不好用」。V1 的白名单是配置文件，还没有图形界面，逐条加上去即可。',
  },
  {
    key: 'available',
    q: '现在能下载了吗？',
    a: '还不能。托盘、面板、气闸与沙箱都还在实现中，没有可发布的安装包，官网也不放占位链接。',
  },
  {
    key: 'account',
    q: '有账号吗？会上报数据吗？另外收费吗？',
    a: '没有账号，没有云同步，没有遥测上报 —— 这三样都在「明确不做」里。模型走你自己在 OSW 里配的渠道，abx 不代售模型、也不经手账单。',
  },
] as const

export const Faq = () => {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="faq-title"
      className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
      id="faq"
    >
      <SectionHeading
        eyebrow={t('faq.eyebrow', '常见问题')}
        id="faq-title"
        lead={t(
          'faq.lead',
          '下面这些都是决定用不用之前会问的。答不上来的问题不该靠猜 —— 所以这里只写有依据的答案。',
        )}
        title={t('faq.title', '你大概会问的八件事')}
      />

      <dl className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2">
        {ITEMS.map(item => (
          <div className="border-t border-line pt-5" key={item.key}>
            <dt className="text-base font-medium text-ink">
              {t(`faq.item.${item.key}.q`, item.q)}
            </dt>
            <dd className="mt-2 text-sm leading-relaxed text-ink-3">
              {t(`faq.item.${item.key}.a`, item.a)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
