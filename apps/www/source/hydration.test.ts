import { describe, expect, it } from 'vitest'
import {
  PRERENDERED_LANG,
  PRERENDERED_THEME,
  shouldHydrate,
  type HydrationState,
} from './hydration'
import { initialTheme } from './theme'

const matching: HydrationState = {
  hasPrerenderedMarkup: true,
  lang: PRERENDERED_LANG,
  theme: PRERENDERED_THEME,
}

describe('hydration decision', () => {
  it('hydrates only the exact state that was prerendered', () => {
    expect(shouldHydrate(matching)).toBe(true)
  })

  it('renders from scratch when the page has no prerendered markup', () => {
    // 开发服务器（`pnpm dev`）给的是空的 #root，不能对它调用 hydrateRoot。
    expect(shouldHydrate({ ...matching, hasPrerenderedMarkup: false })).toBe(false)
  })

  it('renders from scratch for ?lang=en and English browsers', () => {
    // 客户端 i18n 识别为英文时，预渲染的中文标记与它将产出的一切都不一致。
    expect(shouldHydrate({ ...matching, lang: 'en' })).toBe(false)
  })

  it('renders from scratch for ?theme=light and light system preferences', () => {
    // 主题会改变顶栏开关的图标与 aria-label，因此也是标记的一部分。
    expect(shouldHydrate({ ...matching, theme: 'light' })).toBe(false)
    expect(shouldHydrate({ ...matching, theme: undefined })).toBe(false)
  })

  it('prerenders the dark theme that a server render actually produces', () => {
    // 构建时没有 `document`，`initialTheme()` 的兜底值必须就是断言里的那份主题；
    // 这条把 `hydration.ts` 的常量与 `theme.ts` 的行为绑在一起。
    expect(initialTheme()).toBe(PRERENDERED_THEME)
  })

  it('prerenders the fallback language', () => {
    expect(PRERENDERED_LANG).toBe('zh')
  })
})
