// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_ROWS } from '../agents'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * 这一节的判据是「页面上没有手抄的 agent 数据」：
 * 卡片数量跟着清单走，卡片里的值等于清单里的值，清单里没有的东西显示为「没有」。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /三个 agent|Three agents/ })
const cardFor = (label: string) => within(section()).getByRole('heading', { name: label })

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('agent overview', { timeout: FULL_PAGE_TIMEOUT }, () => {
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

  it('shows the built image reference, and says "not built yet" for the others', async () => {
    await renderApp('zh')

    // 哪几条已经构建由数据层现算，这里不手抄「claude / codex 构建了、dsh 没有」——
    // 手抄的那份会在下一个镜像建出来时变成一条假绿（或者一条假红）。
    expect(AGENT_ROWS.some(row => row.image.state === 'built')).toBe(true)

    for (const row of AGENT_ROWS) {
      const card = textOf(cardFor(row.label).closest('article'))
      if (row.image.state === 'built') {
        // 构建了的那条显示 `仓库:版本`。
        expect(card).toContain(`${row.image.repository}:${row.image.version}`)
      } else {
        // 没构建的那条 version 是 `unbuilt` —— 那是给脚本看的哨兵值，
        // 页面上必须是「镜像尚未构建」，不能拼成 `仓库:unbuilt`。
        expect(card).toContain('镜像尚未构建')
        expect(card).not.toContain('unbuilt')
      }
    }
  })

  it('has the English copy for the unbuilt image', async () => {
    await renderApp('en')

    const unbuilt = AGENT_ROWS.find(row => row.image.state === 'unbuilt')
    if (unbuilt === undefined) throw new Error('清单里没有未构建镜像的 agent，这条用例验不到东西')

    const card = textOf(cardFor(unbuilt.label).closest('article'))
    expect(card).toContain('not built yet')
    expect(card).not.toContain('unbuilt')
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
