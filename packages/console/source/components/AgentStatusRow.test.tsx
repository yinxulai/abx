// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusRow, type PanelAgent } from './AgentStatusRow'

// 三种形态与注册表一致：有标识有颜色 / 只有标识 / 整个没有图标。
// 第三个的镜像还没构建（`unbuilt`），所以它是「不可用」而不是「未运行」。
const AGENTS: readonly PanelAgent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    icon: { slug: 'claude', color: '#d97757' },
    image: 'abx-agent-claude:2.1.308',
    imageBuilt: true,
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    icon: { slug: 'codex' },
    image: 'abx-agent-codex:0.164.0',
    imageBuilt: true,
  },
  { id: 'dsh', label: 'dsh', image: 'abx-agent-dsh:unbuilt', imageBuilt: false },
]

const IDLE = 'Claude Code：未运行，点击启动'
const RUNNING = 'Claude Code：运行中，点击聚焦'
const UNAVAILABLE = 'dsh：不可用，先构建镜像'

afterEach(cleanup)

describe('AgentStatusRow', () => {
  it('makes every tile a button with an accessible name', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      IDLE,
      'OpenAI Codex CLI：未运行，点击启动',
      UNAVAILABLE,
    ])
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('exposes the running state through aria-pressed, not just styling', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={['codex']} onStart={() => {}} />)

    expect(screen.getByRole('button', { name: 'OpenAI Codex CLI：运行中，点击聚焦' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: IDLE }).getAttribute('aria-pressed')).toBe('false')
  })

  it('puts exactly one state on each tile, from the state table', () => {
    // 状态表（设计体系 §5）逐行落在 `data-state` 上；样式按它分三段写。
    // 三档互斥：一个方块不可能既「在跑」又「没构建」。
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={() => {}} />)

    const states = screen.getAllByRole('button').map((button) => button.getAttribute('data-state'))
    expect(states).toEqual(['running', 'idle', 'unavailable'])
  })

  it('asks the host to start the agent when an idle tile is clicked', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Codex CLI：未运行，点击启动' }))

    expect(onStart).toHaveBeenCalledWith('codex')
  })

  it('says why a tile is unavailable and what the next step is', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const tile = screen.getByRole('button', { name: UNAVAILABLE })
    // 原因与下一步都要在**看得见的地方**，不能只藏在 aria 里。
    expect(tile.textContent).toContain('镜像未构建')
    expect(tile.textContent).toContain('先构建镜像')
    // 是哪个镜像没构建，说清楚——「有个东西没装」不是一句能照着做的话。
    expect(tile.getAttribute('title')).toBe('abx-agent-dsh:unbuilt 还没构建 · 先构建镜像')
  })

  it('does not let an unavailable tile start anything', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={onStart} />)

    const tile = screen.getByRole('button', { name: UNAVAILABLE })
    expect((tile as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(tile)

    expect(onStart).not.toHaveBeenCalled()
  })

  it('keeps the agent name out of the state business', () => {
    // 名字这一行不随状态改写文案，也不在组件里改样式：状态由下面那行字说。
    // 「永不随状态变淡」那条规则落在 `styles.css`，由 styles.test.ts 盯着。
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={() => {}} />)

    const names = screen.getAllByRole('button').map((button) => button.querySelector('.abx-agent-name')?.textContent)
    expect(names).toEqual(['Claude Code', 'OpenAI Codex CLI', 'dsh'])
    for (const name of screen.getAllByRole('button').map((button) => button.querySelector('.abx-agent-name'))) {
      expect(name?.hasAttribute('data-state')).toBe(false)
      expect(name?.getAttribute('style')).toBeNull()
    }
  })

  it('takes the icon from the manifest, and falls back to the first letter', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const square = (name: string): HTMLElement => {
      const tile = screen.getByRole('button', { name })
      const element = tile.querySelector('.abx-agent-square')
      if (element === null) throw new Error(`没有找到 ${name} 的方块`)
      return element as HTMLElement
    }

    // 有标识有颜色：data-icon 是图形资产的锚点，颜色走自定义属性。
    const claude = square(IDLE)
    expect(claude.getAttribute('data-icon')).toBe('claude')
    expect(claude.style.getPropertyValue('--abx-agent-color')).toBe('#d97757')
    // 方块里仍然是 label 的第一个字。
    expect(claude.textContent).toBe('C')

    // 只有标识、没有颜色：变量缺席，样式退回中性色。
    const codex = square('OpenAI Codex CLI：未运行，点击启动')
    expect(codex.getAttribute('data-icon')).toBe('codex')
    expect(codex.style.getPropertyValue('--abx-agent-color')).toBe('')

    // 没有图标：属性整个不出现，回退到字母块。
    const dsh = square(UNAVAILABLE)
    expect(dsh.hasAttribute('data-icon')).toBe(false)
    expect(dsh.textContent).toBe('d')
  })

  it('does not restart an agent that is already running', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: RUNNING }))

    expect(onStart).not.toHaveBeenCalled()
  })
})
