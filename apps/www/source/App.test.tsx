// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from './test-support'

/**
 * 官网是产品的门面，也是唯一一处把安全承诺写死给人看的地方。
 * 这里只锁三件会悄悄腐烂的事：标题结构、页内锚点、以及**下载区不许有链接**。
 *
 * 显式 `cleanup`：工作区共用的 vitest 配置没有开 `globals`，
 * Testing Library 的自动清理因此不会注册，同一个文件里第二次 `render` 会叠加两份 DOM。
 */
afterEach(cleanup)

describe('landing page', () => {
  it('leads with exactly one h1 that states the positioning', async () => {
    await renderApp()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(textOf(headings[0])).toContain('给 AI coding agent 的隔离舱')
  })

  it('gives every section a name that resolves to a heading', async () => {
    const { container } = await renderApp()

    const sections = [...container.querySelectorAll('section[aria-labelledby]')]
    expect(sections).toHaveLength(5)

    const levels = sections.map(section => {
      const heading = container.querySelector(`#${section.getAttribute('aria-labelledby') ?? ''}`)

      expect(textOf(heading).length).toBeGreaterThan(0)
      return heading?.tagName
    })

    // 首屏的标签指向 h1，其余四节各有一个 h2：标题层级只有这两级。
    expect(levels.filter(level => level === 'H1')).toHaveLength(1)
    expect(levels.filter(level => level === 'H2')).toHaveLength(4)
  })

  it('points every in-page link at a target that is rendered', async () => {
    const { container } = await renderApp()

    const fragments = [...container.querySelectorAll('a[href^="#"]')].map(link =>
      link.getAttribute('href'),
    )
    expect(fragments.length).toBeGreaterThan(0)

    for (const fragment of fragments) {
      expect(fragment).not.toBe('#')
      expect(container.querySelector(fragment ?? '')).not.toBeNull()
    }
  })

  it('offers no download while there is nothing to download', async () => {
    await renderApp()

    const downloads = screen.getByRole('region', { name: /macOS 版/ })
    expect(within(downloads).queryAllByRole('link')).toHaveLength(0)
    expect(within(downloads).queryAllByRole('button')).toHaveLength(0)
    expect(textOf(downloads)).toContain('尚未提供')
  })

  it('states the limits of the sandbox next to the boundaries', async () => {
    await renderApp()

    const boundaries = screen.getByRole('region', { name: /默认安全/ })
    expect(textOf(boundaries)).toContain('明确不承诺什么')
    expect(textOf(boundaries)).toContain('不承诺防住内核级逃逸')
  })

  it('hides the decorative tray mock from assistive technology', async () => {
    const { container } = await renderApp()

    const mock = container.querySelector('figure [aria-hidden="true"]')
    expect(mock).not.toBeNull()
    expect(container.querySelector('figure figcaption')).not.toBeNull()
  })
})
