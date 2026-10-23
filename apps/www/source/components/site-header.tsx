import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LANGS, type Lang } from '../i18n'
import type { Theme } from '../theme'
import { AirlockMark } from './airlock-mark'

type SiteHeaderProps = {
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

/** 顶栏里的锚点导航。id 对应各区块的 `id` 属性，顺序与页面顺序一致。 */
const ANCHORS = [
  { id: 'model', key: 'nav.model', fallback: '凭据模型' },
  { id: 'agents', key: 'nav.agents', fallback: 'Agent 一览' },
  { id: 'start', key: 'nav.start', fallback: '开始使用' },
  { id: 'boundaries', key: 'nav.boundaries', fallback: '边界' },
  { id: 'faq', key: 'nav.faq', fallback: '常见问题' },
  { id: 'changelog', key: 'nav.changelog', fallback: '更新日志' },
  { id: 'download', key: 'nav.download', fallback: '下载' },
] as const

/**
 * 常驻顶栏：品牌、锚点导航、主题开关、语言开关。
 *
 * 交互元素的可点区域**在窄屏一律 ≥44×44**（`size-11`/`min-h-11`），宽屏才收回
 * `h-8`/`py-1` —— 手机上顶栏会因此占三行，这是刻意的取舍：一行塞得下的代价是
 * 每个开关都小到点不准。`audit.mjs` 的 tap-target 判据（手机 44px）守着这条。
 *
 * **窄屏不吸顶**（`md:sticky`）：三行顶栏贴在屏幕上有 190px 高，而手机上的页面
 * 有一万三千多像素 —— 一路滚下去等于每屏少掉四分之一。宽屏一行放得下，吸顶才有
 * 价值（锚点在视口里随手可点）。手机要回顶部，用品牌那一行的链接。
 */
export const SiteHeader = (props: SiteHeaderProps) => {
  const { theme, onThemeChange } = props
  const { t, i18n } = useTranslation()
  const lang = i18n.language as Lang

  return (
    <header className="z-40 border-b border-line bg-surface-chrome backdrop-blur-md md:sticky md:top-0">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2">
        <a
          className="flex items-center gap-2.5 rounded-sm py-2 pr-2"
          href="#main"
          title={t('nav.home', '回到页面开头')}
        >
          <AirlockMark className="size-7 text-ink" />
          <span className="text-base font-semibold tracking-tight">abx</span>
          <span className="text-xs text-ink-4">气闸</span>
        </a>

        <nav
          aria-label={t('nav.label', '页面章节')}
          className="order-last w-full border-t border-line pt-1 md:order-none md:ml-auto md:w-auto md:border-0 md:pt-0"
        >
          <ul className="flex flex-wrap items-center gap-x-1 text-sm">
            {ANCHORS.map(anchor => (
              <li key={anchor.id}>
                <a
                  className="block px-3 py-3 text-ink-3 transition-colors hover:text-ink md:py-1.5"
                  href={`#${anchor.id}`}
                >
                  {t(anchor.key, anchor.fallback)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1.5 md:ml-0">
          <ThemeToggle theme={theme} onChange={onThemeChange} />
          <LangSwitch
            current={lang}
            onChange={next => void i18n.changeLanguage(next)}
          />
          <p className="hidden shrink-0 items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-ink-3 lg:flex">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
            {t('nav.status', 'macOS · 开发中')}
          </p>
        </div>
      </div>
    </header>
  )
}

type ThemeToggleProps = {
  theme: Theme
  onChange: (theme: Theme) => void
}

function ThemeToggle(props: ThemeToggleProps) {
  const { theme, onChange } = props
  const { t } = useTranslation()
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  const label =
    next === 'light'
      ? t('nav.themeLight', '切换到亮色主题')
      : t('nav.themeDark', '切换到暗色主题')

  return (
    <button
      aria-label={label}
      className="inline-flex size-11 items-center justify-center rounded-lg border border-line text-ink-3 transition-colors hover:border-line-strong hover:text-ink md:size-8"
      onClick={() => onChange(next)}
      title={label}
      type="button"
    >
      {theme === 'dark' ? (
        <Sun aria-hidden="true" className="size-4" />
      ) : (
        <Moon aria-hidden="true" className="size-4" />
      )}
    </button>
  )
}

type LangSwitchProps = {
  current: Lang
  onChange: (next: Lang) => void
}

/** 语言开关：两档分段控件，选中项用实心底。 */
function LangSwitch(props: LangSwitchProps) {
  const { current, onChange } = props
  const { t } = useTranslation()

  return (
    <div
      aria-label={t('nav.language', '语言')}
      className="flex items-center rounded-lg border border-line p-0.5"
      role="group"
    >
      {LANGS.map(lang => (
        <button
          aria-pressed={lang.id === current}
          // 高度在窄屏撑到 44（`min-h-11`）：`py-3` 加 12px 行高只有 40，
          // 差那 4px 正是 `audit.mjs` 的 tap-target 判据会拦下的。宽屏收回 24。
          className={`min-h-11 rounded-md px-2.5 py-3 text-xs transition-colors md:min-h-8 md:py-1 ${
            lang.id === current ? 'bg-ink font-medium text-void' : 'text-ink-3 hover:text-ink'
          }`}
          key={lang.id}
          onClick={() => onChange(lang.id)}
          type="button"
        >
          {lang.label}
        </button>
      ))}
    </div>
  )
}
