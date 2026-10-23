// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_ROWS } from '../agents'
import { renderApp, textOf } from '../test-support'

/**
 * 这一节的判据是「页面上没有手抄的 agent 数据」：
 * 卡片数量跟着清单走，卡片里的值等于清单里的值，清单里没有的东西显示为「没有」。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /三个 agent|Three agents/ })
const cardFor = (label: string) => within(section()).getByRole('heading', { name: label })

describe('agent overview', () => {
  it('renders one card per manifest entry', async () => {
    await renderApp('zh')

    const cards = within(section()).getAllByRole('article')
    expect(cards).toHaveLength(AGENT_ROWS.length)
    expect(cards.map(card => textOf(within(card).getByRole('heading', { level: 3 })))).toEqual(
      AGENT_ROWS.map(row => row.label),
    )
  })

  it('shows each agent upstream and command straight from the manifest', async () => {
    await renderApp('zh')

    for (const row of AGENT_ROWS) {
      const card = cardFor(row.label).closest('article')
      if (card === null) throw new Error(`${row.label} 没有卡片`)

      expect(textOf(card)).toContain(row.upstreamId)
      expect(textOf(card)).toContain(row.command)
      expect(textOf(card)).toContain(row.tokenEnv)
      expect(textOf(card)).toContain(row.placeholderToken)
      expect(textOf(card)).toContain(row.statePaths[0] ?? '')
    }
  })

  it('admits that no per-agent image is declared instead of borrowing one', async () => {
    await renderApp('zh')

    expect(textOf(section())).toContain('清单未按 agent 指定')
    // 真出现镜像之后，这里会变成 `仓库:tag`，所以「未指定」不该被写死成永久文案。
    expect(AGENT_ROWS.every(row => row.image === null)).toBe(true)
  })

  it('marks the manifest entries that are not verified yet', async () => {
    await renderApp('zh')

    const unconfirmed = AGENT_ROWS.filter(row => row.status === 'unconfirmed')
    expect(unconfirmed.length).toBeGreaterThan(0)

    for (const row of unconfirmed) {
      const card = cardFor(row.label).closest('article')
      expect(textOf(card)).toContain('待核对')
    }

    expect(textOf(section())).toContain('已核对')
  })

  it('says out loud that per-cell persistence is not there yet', async () => {
    await renderApp('zh')

    expect(textOf(section())).toContain('按舱持久化还在实现中')
  })

  it('explains that the upstream column is a default, not the whole story', async () => {
    await renderApp('zh')

    expect(textOf(section())).toContain('默认上游')
    expect(textOf(section())).toContain('舱外 OSW')
  })
})
