// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { AbxBridge } from './bridge'

/*
 * 面板在 jsdom 里渲染，断言的是**用户能看到与读屏能读到的东西**：
 * 空态文案、三个 agent 方块的可访问名与 `aria-pressed`、以及拖入路径后列表里出现文件名。
 * 样式不断言 —— 颜色改一版不该让测试红。
 */

/** jsdom 没有 ResizeObserver；面板里用它量高，给个静默替身。 */
class NoopResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

let droppedFilesListener: ((paths: string[]) => void) | undefined

function installBridge(): void {
  const bridge: AbxBridge = {
    reportPanelHeight: () => {},
    onDroppedFiles: (callback) => {
      droppedFilesListener = callback
      return () => {
        droppedFilesListener = undefined
      }
    },
    hide: () => {},
  }
  Object.defineProperty(window, 'abx', { value: bridge, configurable: true })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  droppedFilesListener = undefined
  installBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'abx')
})

describe('App', () => {
  it('renders the empty shared state and the idle status', () => {
    render(<App />)

    expect(screen.getByText('把文件拖到托盘图标，或拖到这里')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('待启动')
  })

  it('renders one start button per agent, with an accessible name and pressed state', () => {
    render(<App />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Claude Code：未运行，点击启动')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
  })

  it('flips an agent to running when its tile is clicked', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code：未运行，点击启动' }))

    const running = screen.getByRole('button', { name: 'Claude Code：运行中' })
    expect(running.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('1 舱')
  })

  it('lists a dropped file by its base name', () => {
    render(<App />)

    act(() => {
      droppedFilesListener?.(['/Users/alain/specs/design-spec.pdf'])
    })

    expect(screen.getByText('design-spec.pdf')).toBeTruthy()
    expect(screen.getByText('1 项')).toBeTruthy()
  })
})
