import { FALLBACK_LANG, type Lang } from './i18n'
import type { Theme } from './theme'

/**
 * 预渲染**唯一**产出的那一份状态：中文（兜底语言）+ 深色主题。
 *
 * 为什么主题是深色：构建时没有 `document`，`initialTheme()` 走最后一条兜底分支
 * 返回 `dark`；而 `useEffect` 在服务端不执行，主题不会被改。主题确实影响标记
 * （`SiteHeader` 的主题开关在深色下显示太阳、`aria-label` 是「切换到亮色主题」），
 * 所以它必须参与水合判据，不能只看语言。
 */
export const PRERENDERED_LANG: Lang = FALLBACK_LANG
export const PRERENDERED_THEME: Theme = 'dark'

export type HydrationState = {
  /** `#root` 里是否已有预渲染出来的标记（开发服务器里是空的）。 */
  hasPrerenderedMarkup: boolean
  /** `i18n.language` 在当前页面上的实际值。 */
  lang: string
  /** 内联脚本在首帧之前写下的 `data-theme`（`theme.ts` 读的就是它）。 */
  theme: string | undefined
}

/**
 * 只有「当前页面的状态」与「预渲染时的状态」完全一致才水合。
 *
 * 不一致时调用方走 `createRoot`：整棵客户端树重渲染，React 不会拿旧标记做比对，
 * 因此不会产生 hydration mismatch 报错，也不会白屏。代价只是这些路径少了一次
 * DOM 复用 —— 例如 `?lang=en`（英文浏览器同理）或 `?theme=light`。
 *
 * 判据故意写得比「能不能水合」更保守：宁可多一次重渲染，也不要在控制台里留下
 * 一条 mismatch，那是以后没人会去看的腐烂信号。
 */
export function shouldHydrate(state: HydrationState): boolean {
  if (!state.hasPrerenderedMarkup) return false
  return state.lang === PRERENDERED_LANG && state.theme === PRERENDERED_THEME
}
