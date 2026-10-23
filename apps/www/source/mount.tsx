import { StrictMode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { App } from './App'
import { shouldHydrate } from './hydration'
import i18n from './i18n'

/**
 * 把整页挂到容器上：能水合就水合，不能就重渲染。
 *
 * 单独成文件是为了让「水合不砸掉预渲染 DOM」这件事可以被测试直接调用
 * （见 `mount.test.tsx`）；`main.tsx` 只负责找到容器和引入样式。
 * 返回 React root，测试可以在 `act` 里卸载它，避免影响下一个用例。
 *
 * 判据在 `hydration.ts`：预渲染固定是「中文 + 深色」。当前页面只要有一项不同
 * （`?lang=en`、英文浏览器、`?theme=light`、跟随系统的浅色），就走 `createRoot`
 * 整棵重渲染 —— 不比对旧标记，所以不会有 mismatch 报错，也不会白屏。
 * 开发服务器给的 `#root` 是空的，同样走 `createRoot`。
 */
export function mountApp(container: HTMLElement): Root {
  const tree = (
    <StrictMode>
      <App />
    </StrictMode>
  )

  if (
    shouldHydrate({
      hasPrerenderedMarkup: container.hasChildNodes(),
      lang: i18n.language,
      theme: document.documentElement.dataset.theme,
    })
  ) {
    return hydrateRoot(container, tree)
  }

  const root = createRoot(container)
  root.render(tree)
  return root
}
