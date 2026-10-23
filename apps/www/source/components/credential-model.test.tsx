// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * 这一节是产品的立身之本，所以判据不是「有没有这一段」，而是**四条性质一条不少、
 * 且每条都带着机制**（没有机制的口号改一个字就能骗人，机制改不动）。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /密钥不进舱|Keys do not enter/ })

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('credential model', { timeout: FULL_PAGE_TIMEOUT }, () => {
  it('states all four properties of the model', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('密钥留在舱外的宿主')
    expect(body).toContain('舱里只有一个占位符')
    expect(body).toContain('出口默认拒绝')
    expect(body).toContain('所有进出留痕')
  })

  it('explains the mechanism behind each property, not just the claim', async () => {
    await renderApp('zh')

    const cards = within(section()).getAllByRole('listitem')
    const principle = cards.slice(0, 4)
    expect(principle).toHaveLength(4)

    for (const card of principle) {
      // 一条「是什么 + 凭什么」的卡片，中文字数在 60 上下；只剩一句口号的卡片
      // （标题加一句「默认就安全」）到不了 50。这条断言不精确，但足以拦住
      // 「把机制删掉、只留标语」这种退化。
      expect(textOf(card).length).toBeGreaterThan(50)
    }
  })

  it('shows the only configuration the agent inside gets', async () => {
    const { container } = await renderApp('zh')

    const sample = container.querySelector('#model pre code')
    expect(textOf(sample)).toContain('baseUrl')
    expect(textOf(sample)).toContain('apiKey')
    // 舱内地址指向气闸舱面，而不是供应商；占位符不是真值。
    expect(textOf(sample)).toContain('气闸舱面')
    expect(textOf(sample)).toContain('***')
  })

  it('splits the held items across OSW, the airlock and the cell', async () => {
    await renderApp('zh')

    const table = within(section()).getByRole('table')
    const rows = within(table).getAllByRole('row')
    // 表头 + 三行持有者。
    expect(rows).toHaveLength(4)

    const body = textOf(table)
    expect(body).toContain('OSW（宿主）')
    expect(body).toContain('abx 气闸（宿主）')
    expect(body).toContain('舱内 agent')
    expect(body).toContain('一个 baseUrl，一个占位符')
  })

  it('answers the awkward questions with the mechanism, not with reassurance', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('舱令牌')
    expect(body).toContain('.credentials.json')
    expect(body).toContain('已注入 / 未注入')
  })
})
