import { AirlockMark } from './airlock-mark'

const NAV_ITEMS = [
  { href: '#model', label: '安全模型' },
  { href: '#how', label: '怎么用' },
  { href: '#boundaries', label: '安全边界' },
  { href: '#download', label: '下载' },
] as const

export const SiteHeader = () => (
  <header className="sticky top-0 z-40 border-b border-line bg-surface-chrome backdrop-blur-md">
    <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
      <a href="#main" className="flex items-center gap-2.5 rounded-sm">
        <AirlockMark className="size-7 text-ink" />
        <span className="text-base font-semibold tracking-tight">abx</span>
        <span className="text-xs text-ink-4">气闸</span>
      </a>

      <nav aria-label="主要" className="ml-auto">
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          {NAV_ITEMS.map(item => (
            <li key={item.href}>
              <a className="text-ink-3 transition-colors hover:text-ink" href={item.href}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <p className="hidden shrink-0 items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-ink-3 md:flex">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
        macOS · 开发中
      </p>
    </div>
  </header>
)
