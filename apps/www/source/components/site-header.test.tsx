// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 顶栏的开关都会悄悄腐烂：语言开关点了不换文案、主题开关只改了按钮图标、
 * 锚点指向一个不存在的 id。三条都在这里锁住。
 *
 * 点击一律走 `fireEvent`：它把「点一下」和随后的重渲染、副作用放在同一个
 * `act` 里，主题是写在 `useEffect` 里的，用裸 `element.click()` 读不到结果。
 */
afterEach(cleanup)

const navOf = () => screen.getByRole('navigation', { name: /页面章节|Page sections/ })

describe('site header', () => {
  it('switches the page to English and back, for real', async () => {
    await renderApp('zh')
    expect(textOf(screen.getByRole('heading', { level: 1 }))).toContain('隔离舱')

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    await screen.findByRole('navigation', { name: 'Page sections' })
    expect(document.documentElement.lang).toBe('en')

    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    await screen.findByRole('navigation', { name: '页面章节' })
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('marks the active language', async () => {
    await renderApp('zh')

    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('switches the theme on the root element', async () => {
    await renderApp('zh')

    // 测试环境里没有 prefers-color-scheme 偏好，所以首帧是深色。
    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: '切换到亮色主题' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: '切换到暗色主题' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('links every anchor navigation item at a section that exists', async () => {
    const { container } = await renderApp('zh')

    const links = within(navOf()).getAllByRole('link')
    expect(links).toHaveLength(7)

    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('#')).toBe(true)
      expect(container.querySelector(href)).not.toBeNull()
    }
  })

  it('remembers the chosen language for the next visit', async () => {
    await renderApp('zh')

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    await screen.findByRole('navigation', { name: 'Page sections' })

    expect(localStorage.getItem('abx-language')).toBe('en')
  })

  it('keeps every control at least 44px tall on a phone', async () => {
    await renderApp('zh')

    // jsdom 不做排版，量不出真实像素，所以这里查的是「有没有那条最小高度」。
    // 真正的判据是 `audit.mjs --viewport 390x844`：它是有布局的浏览器，
    // 量的是实际矩形，手机上一个 <44px 的可点元素就直接判 fatal。
    const controls = [
      ...screen.getAllByRole('button'),
      ...within(navOf()).getAllByRole('link'),
    ]
    const tooShort = controls.filter(control => {
      const classes = control.className
      return !classes.includes('size-11') && !classes.includes('min-h-11') && !classes.includes('py-3')
    })

    expect(tooShort.map(control => control.textContent)).toEqual([])
  })
})
