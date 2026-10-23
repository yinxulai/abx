import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentOverview } from './components/agent-overview'
import { Boundaries } from './components/boundaries'
import { CredentialModel } from './components/credential-model'
import { DownloadSection } from './components/download-section'
import { Hero } from './components/hero'
import { HowItWorks } from './components/how-it-works'
import { SiteFooter } from './components/site-footer'
import { SiteHeader } from './components/site-header'
import type { Lang } from './i18n'
import { applyTheme, initialTheme, syncThemeUrl, type Theme } from './theme'

/**
 * 落地页。整页只负责「背景层 + 区块顺序」，每节的实现都在 `components/` 下。
 *
 * 顺序即叙事：**是什么（首屏）→ 为什么安全（凭据模型）→ 用什么（agent 一览）
 * → 怎么开始 → 边界与不承诺 → 常问的问题 → 更新日志 → 下载**。
 * 每一节回答一个具体问题，读者不用自己判断哪条更重要。
 */
export const App = () => {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as Lang
  const [theme, setTheme] = useState<Theme>(initialTheme)

  // 让 `<html lang>` 跟随界面语言：读屏发音、字体回退、搜索引擎都读它。
  // 首帧的值由 `index.html` 的内联脚本写好，这里只负责切换之后同步。
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  useEffect(() => {
    applyTheme(theme)
    syncThemeUrl(theme)
  }, [theme])

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-void text-ink">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-void"
        href="#main"
      >
        {t('app.skipToContent', '跳到主要内容')}
      </a>

      {/* 背景层：顶部网格 + 两层冷色光晕，只出现在页面上缘，不随内容重复。 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-176">
        <div className="bg-grid absolute inset-0" />
        <div className="animate-drift absolute inset-x-0 top-0 h-120 bg-[radial-gradient(52%_100%_at_50%_-8%,var(--color-glow-ice),transparent_70%)]" />
        <div className="absolute inset-x-0 top-0 h-88 bg-[radial-gradient(38%_100%_at_66%_0%,var(--color-glow-ice-strong),transparent_72%)]" />
      </div>

      <SiteHeader onThemeChange={setTheme} theme={theme} />

      <main className="relative" id="main">
        <Hero />
        <CredentialModel />
        <AgentOverview />
        <HowItWorks />
        <Boundaries />
        <DownloadSection />
      </main>

      <SiteFooter />
    </div>
  )
}
