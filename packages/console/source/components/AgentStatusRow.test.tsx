// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusRow, type PanelAgent } from './AgentStatusRow'

// 两种形态与注册表一致：有标识有颜色 / 只有标识、没有颜色。
// **没有第三种**：镜像还没构建的 agent 进不了这一排（过滤在 `App.tsx`，
// 理由见 `tray-ui.md` §3.1 ④），所以这一排也没有「不可用」那一档。
const AGENTS: readonly PanelAgent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    icon: { slug: 'claude', color: '#d97757' },
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    icon: { slug: 'codex' },
  },
]

const IDLE = 'Claude Code · 未运行，点击启动'
const RUNNING = 'Claude Code · 运行中，点击聚焦'

const tileFor = (name: string): HTMLElement => screen.getByRole('button', { name })

afterEach(cleanup)

describe('AgentStatusRow', () => {
  it('makes every tile a button with an accessible name', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      IDLE,
      'OpenAI Codex CLI · 未运行，点击启动',
    ])
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('renders icon only: no name, no status line', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={() => {}} />)

    // 这一排现在只有图标（`tray-ui.md` §3）。方块里除了图标、状态点与 tooltip，
    // 不该再有别的东西——多一个就是名字那一行悄悄长回来了。
    for (const button of screen.getAllByRole('button')) {
      expect([...button.querySelectorAll('*')].map((child) => child.className)).toEqual([
        'abx-agent-mark',
        'abx-agent-dot',
        'abx-agent-tip',
      ])
    }
  })

  it('gives every tile the name and the state it no longer renders', () => {
    // 硬要求（`tray-ui.md` §3.1 ③）：视觉上把名字省掉之后，`aria-label` 是读屏唯一能拿到
    // 名字的地方。少了它，每个 tile 都退化成一个**无名按钮**。
    render(<AgentStatusRow agents={AGENTS} runningIds={['codex']} onStart={() => {}} />)

    expect(tileFor('OpenAI Codex CLI · 运行中，点击聚焦').getAttribute('aria-label')).toBe(
      'OpenAI Codex CLI · 运行中，点击聚焦',
    )
    for (const button of screen.getAllByRole('button')) {
      // 看得见的那句话与读得出来的那句话是同一个字符串，不会各说各的。
      expect(button.getAttribute('aria-label')).toBe(button.querySelector('.abx-agent-tip')?.textContent)
      // 状态用动作词（`design-system.md` §8）：未运行写「启动」、运行中写「聚焦」。
      expect(button.getAttribute('aria-label')).toMatch(/ · (未运行，点击启动|运行中，点击聚焦)$/)
    }
  })

  it('shows the name through a custom tooltip, not a native title', () => {
    // 名字在**悬停和键盘聚焦**时出现，两条路都由 `styles.css` 的规则放行
    // （`:hover` 与 `:focus-visible` 成对出现，由 `styles.test.ts` 盯着）。
    // 这里钉住另一半：用的是自己的元素，不是原生 `title`——后者延迟约 1 秒，
    // 样式在深浅色下不受控，而名字是这个面板上唯一的文字。
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const tile = tileFor(IDLE)
    expect(tile.getAttribute('title')).toBeNull()

    const tip = tile.querySelector('.abx-agent-tip')
    expect(tip?.textContent).toBe(IDLE)
    // 同一句话已经在 `aria-label` 里了，读屏不该被念两遍。
    expect(tip?.getAttribute('aria-hidden')).toBe('true')
  })

  it('exposes the running state through aria-pressed, not just styling', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={['codex']} onStart={() => {}} />)

    expect(tileFor('OpenAI Codex CLI · 运行中，点击聚焦').getAttribute('aria-pressed')).toBe('true')
    expect(tileFor(IDLE).getAttribute('aria-pressed')).toBe('false')
  })

  it('puts exactly one state on each tile, from the state table', () => {
    // 状态表（`tray-ui.md` §4）逐行落在 `data-state` 上；样式按它分两段写。
    // 两档互斥，而且**只有两档**：第三档属于管理面板，不属于托盘。
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={() => {}} />)

    const states = screen.getAllByRole('button').map((button) => button.getAttribute('data-state'))
    expect(states).toEqual(['running', 'idle'])
  })

  it('asks the host to start the agent when an idle tile is clicked', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={onStart} />)

    fireEvent.click(tileFor('OpenAI Codex CLI · 未运行，点击启动'))

    expect(onStart).toHaveBeenCalledWith('codex')
  })

  it('does not restart an agent that is already running', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={onStart} />)

    fireEvent.click(tileFor(RUNNING))

    expect(onStart).not.toHaveBeenCalled()
  })

  it('takes the icon from the manifest, and falls back to the first letter', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const markOf = (name: string): HTMLElement => {
      const element = tileFor(name).querySelector('.abx-agent-mark')
      if (element === null) throw new Error(`没有找到 ${name} 的图标`)
      return element as HTMLElement
    }

    // 有标识有颜色：data-icon 是图形资产的锚点，颜色走自定义属性，落在 tile 身上
    // （底由 tile 画，标识自己不改对比度责任）。
    const claude = markOf(IDLE)
    expect(claude.getAttribute('data-icon')).toBe('claude')
    expect(tileFor(IDLE).style.getPropertyValue('--abx-agent-color')).toBe('#d97757')

    // 只有标识、没有颜色：变量缺席，样式退回中性色。
    const codex = markOf('OpenAI Codex CLI · 未运行，点击启动')
    expect(codex.getAttribute('data-icon')).toBe('codex')
    expect(tileFor('OpenAI Codex CLI · 未运行，点击启动').style.getPropertyValue('--abx-agent-color')).toBe('')
  })

  it('falls back to the label first letter when the manifest has no icon', () => {
    const noIcon: readonly PanelAgent[] = [{ id: 'bare', label: 'Zed Agent' }]

    render(<AgentStatusRow agents={noIcon} runningIds={[]} onStart={() => {}} />)

    const mark = tileFor('Zed Agent · 未运行，点击启动').querySelector('.abx-agent-mark')
    // 属性整个不出现（不是空字符串）：样式与图形资产据此判断「有没有品牌标识」。
    expect(mark?.hasAttribute('data-icon')).toBe(false)
    expect(mark?.textContent).toBe('Z')
  })
})
