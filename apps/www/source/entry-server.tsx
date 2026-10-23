import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { App } from './App'
import i18n, { FALLBACK_LANG } from './i18n'

/**
 * 预渲染入口：只在构建时由 Node 调用，不进客户端 bundle。
 *
 * 为什么要有它：站点是纯客户端渲染时，`index.html` 里只有一个空的 `#root`，
 * 爬虫、社交平台的摘要抓取、以及关掉 JS 的浏览器都只能拿到 meta。这里在构建时
 * 把整页真正渲染一遍，把结果写回 `index.html`，首屏因此有正文。
 *
 * **只产出中文一份**：中文是源码里的原文、也是兜底语言（见 `i18n.ts`），
 * 一份预渲染就能覆盖默认路径；英文是增量翻译，等真有需要再考虑第二份。
 *
 * **主题固定为深色**：`initialTheme()` 在没有 `document` 时返回 `dark`，而
 * `useEffect` 在服务端不执行，所以这里得到的就是深色下的标记（主题开关显示
 * 「切换到亮色主题」并画太阳）。客户端只有在实际生效的主题也是深色时才水合，
 * 否则走 `createRoot` —— 判据写在 `main.tsx`。
 */
export async function renderLandingPage(): Promise<string> {
  // `i18n` 是模块级单例，初始化时按 `detectLang()` 选语言；Node 里没有
  // `navigator`，于是会落到英文。预渲染固定输出中文，这里显式钉回兜底语言。
  // （已一致时不重复切换，免得无谓地触发 `languageChanged`。）
  if (i18n.language !== FALLBACK_LANG) await i18n.changeLanguage(FALLBACK_LANG)

  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
