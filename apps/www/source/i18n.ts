import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * 双语策略（与 osw 的 `apps/www` 同一套）：
 *
 * - **中文是主要维护语言，也是兜底语言**。中文不建资源表，而是写在
 *   `t(key, '中文文案')` 的第二个参数里，就写在用到它的那个组件里 ——
 *   改文案和改代码在同一个文件里发生。
 * - **英文是增量补的**。key 出现在 `en` 表里就有英文，没出现就回退到中文。
 *   所以漏译一句的结果是「这一句还是中文」，不是空白、不是 key、更不是 404。
 * - 站点是单页，没有路由，因此不存在 `/en` 这样的路径，也就没有「英文页 404」
 *   这回事：语言只是页面上的一个开关，切完还是这一页。
 *
 * 新增文案的顺序：先在组件里写中文兜底，跑 `pnpm test`，`i18n.test.ts` 会列出
 * 缺英文的 key；再决定要不要补。
 */

/** 站点支持的语言。 */
export type Lang = 'en' | 'zh'

export const LANG_STORAGE_KEY = 'abx-language'

export const LANGS: readonly { id: Lang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
]

/** 兜底语言固定为中文：英文缺 key 时回落到组件里内联的中文。 */
export const FALLBACK_LANG: Lang = 'zh'

/**
 * 英文译文表，key 与各组件的 `t()` 第一个参数一一对应。
 *
 * 这里只放英文：中文是「代码里的原文」，英文是「翻译」。两层分开，
 * 就不存在「中文表改了、组件里的原文忘了改」这种双份真相。
 */
export const en = {
  nav: {
    model: 'Credentials',
    agents: 'Agents',
    start: 'Get started',
    boundaries: 'Boundaries',
    faq: 'FAQ',
    download: 'Download',
    themeLight: 'Switch to light theme',
    themeDark: 'Switch to dark theme',
    language: 'Language',
    status: 'macOS · in progress',
  },
} as const

/** 首次进入优先沿用上次选择，其次按浏览器语言；识别不到就用兜底语言（中文）。 */
function detectLang(): Lang {
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY)
      if (stored === 'en' || stored === 'zh') return stored
    } catch {
      // 隐私模式等场景可能禁止访问；继续按浏览器语言判断。
    }
  }
  const preferred = typeof navigator === 'undefined' ? '' : navigator.language
  return preferred.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

i18n.on('languageChanged', (language) => {
  if (language !== 'en' && language !== 'zh') return
  try {
    localStorage.setItem(LANG_STORAGE_KEY, language)
  } catch {
    // 无法持久化不影响当前页面的语言切换。
  }
})

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: detectLang(),
  fallbackLng: FALLBACK_LANG,
  // 纯前端渲染且文案自带中文兜底，插值无需转义。
  interpolation: { escapeValue: false },
  // 资源内联、初始化同步完成，无需 Suspense 边界。
  react: { useSuspense: false },
})

export default i18n
