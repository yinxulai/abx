// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * 首屏是唯一一处「不读下去也能带走」的地方，所以只锁三件事：
 * 承诺里那三条硬性质都在、两个按钮都指向真实存在的一节、图标来自 lucide。
 */
afterEach(cleanup)

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('hero', { timeout: FULL_PAGE_TIMEOUT }, () => {
  it('carries the three properties the rest of the page then has to back up', async () => {
    await renderApp('zh')

    const hero = screen.getByRole('heading', { level: 1 }).closest('section')
    const body = textOf(hero)
    expect(body).toContain('零密钥进舱')
    expect(body).toContain('默认拒绝出网')
    expect(body).toContain('全程审计')
  })

  it('sends both buttons to sections that exist', async () => {
    const { container } = await renderApp('zh')

    const hero = screen.getByRole('heading', { level: 1 }).closest('section')
    const links = [...(hero?.querySelectorAll('a[href^="#"]') ?? [])]
    expect(links.map(link => link.getAttribute('href'))).toEqual(['#model', '#start'])

    for (const link of links) {
      expect(container.querySelector(link.getAttribute('href') ?? '')).not.toBeNull()
    }
  })

  it('draws its icons with lucide, not with hand-written paths', async () => {
    await renderApp('zh')

    const hero = screen.getByRole('heading', { level: 1 }).closest('section')
    // 面板示意里的品牌标不算图标，它是 logo，本来就该是手绘的那一个。
    const icons = [...(hero?.querySelectorAll('svg') ?? [])].filter(
      icon => icon.closest('figure') === null,
    )
    expect(icons.length).toBeGreaterThan(0)
    expect(icons.filter(icon => !icon.classList.contains('lucide'))).toEqual([])
  })

  it('reads as English when the page is in English', async () => {
    await renderApp('en')

    expect(textOf(screen.getByRole('heading', { level: 1 }))).toBe(
      'An airlock for your AI coding agent',
    )
  })
})
