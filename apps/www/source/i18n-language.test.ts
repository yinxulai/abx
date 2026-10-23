// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { detectLang, LANG_STORAGE_KEY, syncLangUrl } from './i18n'

/**
 * 「打开这一页时是哪种语言」单独一个文件测。
 *
 * `i18n.test.ts` 要扫源码树（node 环境，`import.meta.url` 是 `file://`），
 * 而这里要 `localStorage` / `navigator` / `location`（jsdom 环境，`import.meta.url`
 * 变成 `http://`）—— 两边的环境要求相反，硬凑在一个文件里只会让其中一边失真。
 */
const setUrl = (search: string) => window.history.replaceState(null, '', `/${search}`)

afterEach(() => {
  localStorage.removeItem(LANG_STORAGE_KEY)
  setUrl('')
})

describe('detectLang', () => {
  it('falls back to the browser language when nothing is pinned or stored', () => {
    // jsdom 的 navigator.language 是 en-US，所以不钉语言就是英文 ——
    // 这也正是无头浏览器直接截图会拍到英文页的原因。
    expect(detectLang()).toBe('en')
  })

  it('lets the URL pin the language over the stored choice', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'en')
    setUrl('?lang=zh')

    // 截图、评审、分享一条固定语言的链接都靠它，所以 URL 的优先级最高。
    expect(detectLang()).toBe('zh')
  })

  it('ignores a language that is not one of ours', () => {
    setUrl('?lang=de')

    // 不认识的值当没写，而不是把页面切成一个空语言。
    expect(detectLang()).toBe('en')
  })

  it('remembers the last choice when the URL says nothing', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'zh')
    setUrl('')

    expect(detectLang()).toBe('zh')
  })
})

describe('syncLangUrl', () => {
  it('keeps the current language in the address bar', () => {
    setUrl('')

    syncLangUrl('zh')

    expect(window.location.search).toBe('?lang=zh')
  })
})
