import { render } from '@testing-library/react'
import { App } from './App'
import i18n, { LANG_STORAGE_KEY, type Lang } from './i18n'

/**
 * 渲染整页，并把界面语言钉死。
 *
 * 为什么要钉：语言是单例（`i18n` 模块级初始化），默认按 `navigator.language`
 * 判断 —— jsdom 报的是 `en-US`，于是同样的断言在 CI 和本机可能落在不同语言上。
 * 测试里显式指定，断言才有确定的对象。
 */
export async function renderApp(lang: Lang = 'zh') {
  localStorage.setItem(LANG_STORAGE_KEY, lang)
  await i18n.changeLanguage(lang)
  return render(<App />)
}

export const textOf = (element: Element | null) => element?.textContent ?? ''
