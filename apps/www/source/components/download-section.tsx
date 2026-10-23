import { SectionHeading } from './section-heading'

const FACTS = [
  { label: '平台', value: 'macOS' },
  { label: '状态', value: '开发中' },
  { label: '安装包', value: '尚未提供' },
] as const

/**
 * 下载区暂为占位：产品还没有可发布的安装包。
 * 这里刻意不放任何 `href`、按钮或伪造的下载链接 —— 等真有产物时再加。
 */
export const DownloadSection = () => (
  <section
    aria-labelledby="download-title"
    className="relative mx-auto max-w-6xl border-t border-line px-6 py-20 lg:py-24"
    id="download"
  >
    <SectionHeading
      eyebrow="下载"
      id="download-title"
      lead="托盘和沙箱仍在实现中，还没有可供下载的安装包。"
      title="macOS 版，开发中"
    />

    <div className="mt-12 grid gap-8 rounded-2xl border border-line bg-surface-0 p-6 sm:p-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
      <div>
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
          第一版只做 macOS
        </p>
        <p className="mt-4 text-xl font-medium text-ink">发布后，下载入口会出现在这里。</p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-3">
          在此之前这里不放占位链接。产品能力和进度以项目路线图为准，
          不在这里提前承诺一个日期。
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3 rounded-xl border border-line bg-surface-1/60 p-4 text-sm">
        {FACTS.map(fact => (
          <div key={fact.label}>
            <dt className="text-xs text-ink-4">{fact.label}</dt>
            <dd className="mt-1 text-ink-2">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  </section>
)
