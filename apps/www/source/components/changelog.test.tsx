// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 更新日志最容易变成两种谎话：编一个发布日期，或者把「打算做」写成「已经做完」。
 * 两条都在这里锁住。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /只记发布过的东西|Only what has been released/ })

describe('changelog', () => {
  it('has exactly one entry, and it is the unreleased one', async () => {
    await renderApp('zh')

    // 只数版本条目本身：每个条目里还有一个「包含什么」的 <ul>，
    // 按 role 取会把它们一起捞出来。
    const entries = [...section().querySelectorAll('ol > li')]
    expect(entries).toHaveLength(1)

    const body = textOf(entries[0] ?? null)
    expect(body).toContain('0.1.0')
    expect(body).toContain('未发布')
  })

  it('scopes the entry as a plan rather than a record of finished work', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('这是范围，不是成绩单')
    expect(body).toContain('还没有全部做完')
  })

  it('claims no date, because nothing has shipped', async () => {
    await renderApp('zh')

    // 编一个日期是这一节最省事也最便宜的谎：真发布了再加。
    const body = textOf(section())
    expect(body).not.toMatch(/20\d\d[-/年]/)
  })

  it('says where progress is tracked instead of keeping a second list here', async () => {
    await renderApp('zh')

    expect(textOf(section())).toContain('路线图')
  })
})
