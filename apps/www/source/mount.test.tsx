// @vitest-environment jsdom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderLandingPage } from './entry-server'
import i18n from './i18n'
import { mountApp } from './mount'

/**
 * 预渲染只有配上水合才有价值：`createRoot` 会把已有的正文扔掉重画。
 * 这里用真实的服务端渲染结果 + 真实的 `mountApp` 走两条路径，断言
 * 「状态一致时复用 DOM、不一致时重渲染，两边都不往控制台写 mismatch」。
 */

// React 只在 act 环境里才把水合当作同步任务处理；不设这个标志，
// `act` 会自己报一条与本次断言无关的警告。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const consoleError = vi.spyOn(console, 'error')
let root: Root | null = null

beforeEach(() => {
  consoleError.mockClear()
})

// 一个用例挂上的树必须卸载：否则下一个用例改语言时，上一个用例的
// 组件会在 `act` 之外更新，报出与本次断言无关的警告。
afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  document.body.innerHTML = ''
})

/**
 * 用真实的预渲染结果铺好文档，再切到用例要模拟的页面状态。
 * 顺序不能反：`renderLandingPage` 会把语言钉回中文（那才是构建时的状态）。
 */
async function prerenderIntoDocument(theme: string, lang: 'zh' | 'en'): Promise<HTMLElement> {
  const markup = await renderLandingPage()
  document.documentElement.dataset.theme = theme
  document.body.innerHTML = `<div id="root">${markup}</div>`

  if (i18n.language !== lang) await i18n.changeLanguage(lang)

  const container = document.querySelector<HTMLElement>('#root')
  if (container === null) throw new Error('#root not found')
  return container
}

describe('mounting the prerendered page', () => {
  it('hydrates Chinese + dark without replacing the prerendered nodes', async () => {
    const container = await prerenderIntoDocument('dark', 'zh')

    const headingBefore = container.querySelector('h1')
    expect(headingBefore?.textContent).toBe('给 AI coding agent 的隔离舱')

    await act(async () => {
      root = mountApp(container)
    })

    // 同一个节点仍然连着文档：说明是水合复用了它，而不是重画了一份。
    expect(headingBefore?.isConnected).toBe(true)
    expect(container.querySelector('h1')).toBe(headingBefore)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('re-renders from scratch for an English page, without mismatch errors', async () => {
    const container = await prerenderIntoDocument('dark', 'en')

    const headingBefore = container.querySelector('h1')

    await act(async () => {
      root = mountApp(container)
    })

    const heading = container.querySelector('h1')
    expect(heading?.textContent).toBe('An airlock for your AI coding agent')
    // 旧节点被替换：这正是 createRoot 路径的预期，且不会产生 mismatch 报错。
    expect(heading).not.toBe(headingBefore)
    expect(headingBefore?.isConnected).toBe(false)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('re-renders from scratch for the light theme, without mismatch errors', async () => {
    const container = await prerenderIntoDocument('light', 'zh')

    const headingBefore = container.querySelector('h1')

    await act(async () => {
      root = mountApp(container)
    })

    expect(container.querySelector('h1')).not.toBe(headingBefore)
    expect(container.querySelector('h1')?.textContent).toBe('给 AI coding agent 的隔离舱')
    expect(consoleError).not.toHaveBeenCalled()
  })
})
