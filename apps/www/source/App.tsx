import { Boundaries } from './components/boundaries'
import { CredentialModel } from './components/credential-model'
import { DownloadSection } from './components/download-section'
import { Hero } from './components/hero'
import { HowItWorks } from './components/how-it-works'
import { SiteFooter } from './components/site-footer'
import { SiteHeader } from './components/site-header'

/**
 * 落地页。顺序即叙事：**是什么（首屏）→ 为什么安全 → 怎么用 → 边界 → 下载**。
 * 每一节的实现都在 `components/` 下，这里只负责背景层与顺序。
 */
export const App = () => (
  <div className="relative min-h-screen overflow-x-hidden bg-void text-ink">
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-void"
    >
      跳到主要内容
    </a>

    {/* 背景层：顶部网格 + 两层冷色光晕，只出现在页面上缘，不随内容重复。 */}
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-176">
      <div className="bg-grid absolute inset-0" />
      <div className="animate-drift absolute inset-x-0 top-0 h-120 bg-[radial-gradient(52%_100%_at_50%_-8%,var(--color-glow-ice),transparent_70%)]" />
      <div className="absolute inset-x-0 top-0 h-88 bg-[radial-gradient(38%_100%_at_66%_0%,var(--color-glow-ice-strong),transparent_72%)]" />
    </div>

    <SiteHeader />

    <main id="main" className="relative">
      <Hero />
      <CredentialModel />
      <HowItWorks />
      <Boundaries />
      <DownloadSection />
    </main>

    <SiteFooter />
  </div>
)
