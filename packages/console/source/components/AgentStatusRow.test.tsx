// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusRow, type PanelAgent } from './AgentStatusRow'

// 三种形态与注册表一致：有标识有颜色 / 只有标识 / 整个没有图标。
const AGENTS: readonly PanelAgent[] = [
  { id: 'claude', label: 'Claude Code', icon: { slug: 'claude', color: '#d97757' } },
  { id: 'codex', label: 'OpenAI Codex CLI', icon: { slug: 'codex' } },
  { id: 'dsh', label: 'dsh' },
]

afterEach(cleanup)

describe('AgentStatusRow', () => {
  it('makes every tile a button with an accessible name', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={() => {}} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Claude Code：未运行，点击启动',
      'OpenAI Codex CLI：未运行，点击启动',
      'dsh：未运行，点击启动',
    ])
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('exposes the running state through aria-pressed, not just styling', () => {
    render(<AgentStatusRow agents={AGENTS} runningIds={['codex']} onStart={() => {}} />)

    expect(screen.getByRole('button', { name: 'OpenAI Codex CLI：运行中' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Claude Code：未运行，点击启动' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('asks the host to start the agent when an idle tile is clicked', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={[]} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: 'dsh：未运行，点击启动' }))

    expect(onStart).toHaveBeenCalledWith('dsh')
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
    const claude = square('Claude Code：未运行，点击启动')
    expect(claude.getAttribute('data-icon')).toBe('claude')
    expect(claude.style.getPropertyValue('--abx-agent-color')).toBe('#d97757')
    // 两行结构不变：方块里仍然是 label 的第一个字。
    expect(claude.textContent).toBe('C')

    // 只有标识、没有颜色：变量缺席，样式退回中性色。
    const codex = square('OpenAI Codex CLI：未运行，点击启动')
    expect(codex.getAttribute('data-icon')).toBe('codex')
    expect(codex.style.getPropertyValue('--abx-agent-color')).toBe('')

    // 没有图标：属性整个不出现，回退到字母块。
    const dsh = square('dsh：未运行，点击启动')
    expect(dsh.hasAttribute('data-icon')).toBe(false)
    expect(dsh.textContent).toBe('d')
  })

  it('does not restart an agent that is already running', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code：运行中' }))

    expect(onStart).not.toHaveBeenCalled()
  })
})
