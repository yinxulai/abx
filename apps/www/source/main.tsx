import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { App } from './App'
import { shouldHydrate } from './hydration'
import i18n from './i18n'
import './index.css'

const container = document.getElementById('root')
if (container === null) throw new Error('#root not found')

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
)

/**
 * 预渲染的 `index.html` 里已经有完整首屏，客户端接管时优先水合，保住那份 DOM。
 *
 * `shouldHydrate` 的判据见 `hydration.ts`：预渲染固定是「中文 + 深色」，
 * 当前页面只要有一项不同（`?lang=en`、英文浏览器、`?theme=light`、跟随系统的浅色），
 * 就走 `createRoot` 整棵重渲染 —— 不比对旧标记，所以不会有 mismatch 报错。
 * 开发服务器给的 `#root` 是空的，同样走 `createRoot`。
 */
if (
  shouldHydrate({
    hasPrerenderedMarkup: container.hasChildNodes(),
    lang: i18n.language,
    theme: document.documentElement.dataset.theme,
  })
) {
  hydrateRoot(container, tree)
} else {
  createRoot(container).render(tree)
}
