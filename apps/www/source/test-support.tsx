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

/**
 * 整页挂载的用例统一放宽的超时（毫秒）。
 *
 * 这一档超时是给下面这类用例的：它们把整个 `<App/>` 挂进 jsdom——八个 section、
 * 两套语言的 i18n、外加主题副作用。单个用例本机空载约 0.2–0.9s，而默认的 5000ms
 * 加机器负载就够不着了：三个作业并跑时 `site-header.test.tsx` 超时过一次，
 * 而那次改动**没碰过 `apps/www/` 一个字**，单独重跑、整包重跑都绿。
 *
 * 也就是说，默认值量的是**这台机器当时有多忙**，不是代码对不对。这件事比它看起来重要：
 * CI 是我们对平台工作唯一的证据，一个会因为无关原因变红的闸门，只会教会大家
 * 「重跑到绿为止」，那时它就不再是证据了。
 *
 * 所以整页挂载的 `describe` 显式带上 `{ timeout: FULL_PAGE_TIMEOUT }`。
 * **断言一个都没动**——这里改的是「愿意等多久」，不是「什么算通过」；
 * 真坏了的用例照样会红，只是晚一点红。
 */
export const FULL_PAGE_TIMEOUT = 30_000

export const textOf = (element: Element | null) => element?.textContent ?? ''
