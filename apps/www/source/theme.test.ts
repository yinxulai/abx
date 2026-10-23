// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, initialTheme, syncThemeUrl } from './theme'

const setUrl = (search: string) => window.history.replaceState(null, '', `/${search}`)

afterEach(() => {
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
  setUrl('')
})

describe('initialTheme', () => {
  it('trusts the theme the inline script already applied', () => {
    document.documentElement.dataset.theme = 'light'
    setUrl('?theme=dark')

    // 内联脚本先跑，React 后跑；两边不一致时以内联脚本的结果为准，
    // 否则页面会在首帧之后突然换一套颜色。
    expect(initialTheme()).toBe('light')
  })

  it('honours the theme query parameter when nothing is applied yet', () => {
    setUrl('?theme=light')

    expect(initialTheme()).toBe('light')
  })

  it('ignores values that are not a theme', () => {
    setUrl('?theme=sepia')

    // jsdom 里 matchMedia 默认匹配失败，于是兜底是深色。
    expect(initialTheme()).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('writes the theme onto the root element and the browser theme colour', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.append(meta)

    applyTheme('light')

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(meta.getAttribute('content')).toBe('#f7f8fa')

    applyTheme('dark')

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(meta.getAttribute('content')).toBe('#06080c')

    meta.remove()
  })
})

describe('syncThemeUrl', () => {
  it('keeps the current theme in the address bar', () => {
    setUrl('')

    syncThemeUrl('light')

    expect(window.location.search).toBe('?theme=light')
  })
})
