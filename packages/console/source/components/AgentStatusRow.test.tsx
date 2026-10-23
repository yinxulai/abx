// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusRow, type PanelAgent } from './AgentStatusRow'

const AGENTS: readonly PanelAgent[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
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

  it('does not restart an agent that is already running', () => {
    const onStart = vi.fn()
    render(<AgentStatusRow agents={AGENTS} runningIds={['claude']} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code：运行中' }))

    expect(onStart).not.toHaveBeenCalled()
  })
})
