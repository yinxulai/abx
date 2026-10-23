export type Theme = 'light' | 'dark'

const THEME_VALUES: readonly Theme[] = ['light', 'dark']

function isTheme(value: string | null | undefined): value is Theme {
  return value !== null && value !== undefined && THEME_VALUES.includes(value as Theme)
}

/**
 * 首帧主题：深色还是浅色，要在 React 接管之前就定下来。
 *
 * `index.html` 里有一段内联脚本按同一套规则先写好 `data-theme`（内联脚本执行在
 * 第一帧之前，所以不会先亮一下再变暗）。这里优先读那份结果，读不到再按 URL 参数、
 * 系统偏好兜底 —— 顺序与内联脚本完全一致，两边不一致就会出现「首屏一闪」。
 *
 * 主题不写 localStorage：它跟着系统走，而 URL 参数是唯一需要「钉住」的场合
 * （截图、评审、分享一条固定外观的链接）。要固定就 `?theme=light`。
 */
export function initialTheme(): Theme {
  if (typeof document === 'undefined') return 'dark'

  const applied = document.documentElement.dataset.theme
  if (isTheme(applied)) return applied

  const query = new URLSearchParams(window.location.search).get('theme')
  if (isTheme(query)) return query

  // `matchMedia` 不是到处都有：jsdom 没有实现它，一些内嵌 webview 也没有。
  // 缺了就当系统没有偏好，落到深色——而不是让整个页面在首帧崩掉。
  return prefersLight() ? 'light' : 'dark'
}

function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 把主题写到根节点与浏览器主题色上。 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return

  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  themeColor?.setAttribute('content', theme === 'light' ? '#f7f8fa' : '#06080c')
}

/** 当前主题写回 URL：复制地址后打开的是同一幅界面。 */
export function syncThemeUrl(theme: Theme): void {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  url.searchParams.set('theme', theme)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}
