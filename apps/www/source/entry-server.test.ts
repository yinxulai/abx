import { describe, expect, it } from 'vitest'
import { renderLandingPage } from './entry-server'

/**
 * 预渲染是「首屏有没有正文」这件事的唯一保证，所以这里断言的是**真渲染**出来的
 * 中文句子，而不是 meta 或标题里已有的那几句：
 *
 * - `把仓库和资料递进一个一次性的舱` 是首屏的正文，只有渲染 App 才会出现；
 * - `密钥不进舱，这不是配置出来的` 是第二节的标题，同样不在 head 里。
 *
 * 如果哪天有人把 `App` 换成静态模板、或预渲染漏掉了某个区块，这两条会先红。
 */
describe('prerendered landing page', () => {
  it('renders body copy instead of an empty root', async () => {
    const html = await renderLandingPage()

    expect(html).toContain('给 AI coding agent 的隔离舱')
    expect(html).toContain('把仓库和资料递进一个一次性的舱')
    expect(html).toContain('密钥不进舱，这不是配置出来的')
    // 有真实结构的标记：八个区块各有一个 section。
    expect(html.match(/<section/g)?.length).toBe(8)
  })

  it('always renders the Chinese fallback language', async () => {
    const html = await renderLandingPage()

    // 英文表里的同一句是 'An airlock for your AI coding agent'；
    // 预渲染只出中文一份，不能因为 Node 的 navigator 报 en-US 就变成英文。
    expect(html).toContain('给 AI coding agent 的隔离舱')
    expect(html).not.toContain('An airlock for your AI coding agent')
  })

  it('renders identical markup on every run so hydration can rely on it', async () => {
    const first = await renderLandingPage()
    const second = await renderLandingPage()

    expect(second).toBe(first)
  })
})
