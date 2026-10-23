// @vitest-environment jsdom

import type { SharedEntry, SharedListSnapshot } from '@abx/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { AbxBridge } from './bridge'

/*
 * 面板在 jsdom 里渲染，断言的是**用户能看到与读屏能读到的东西**：
 * 空态文案、三个 agent 方块的可访问名与 `aria-pressed`、
 * 共享列表里的文件名 / 目录图标 / 徽标、以及被拒条目那行原因。
 * 样式不断言 —— 颜色改一版不该让测试红。
 */

/** jsdom 没有 ResizeObserver；面板里用它量高，给个静默替身。 */
class NoopResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

let previewListener: ((entries: readonly SharedEntry[]) => void) | undefined
let snapshotListener: ((snapshot: SharedListSnapshot) => void) | undefined
let listRequests = 0

function installBridge(): void {
  const bridge: AbxBridge = {
    reportPanelHeight: () => {},
    onDroppedEntries: (callback) => {
      previewListener = callback
      return () => {
        previewListener = undefined
      }
    },
    onSharedList: (callback) => {
      snapshotListener = callback
      return () => {
        snapshotListener = undefined
      }
    },
    requestSharedList: () => {
      listRequests += 1
    },
    hide: () => {},
  }
  Object.defineProperty(window, 'abx', { value: bridge, configurable: true })
}

/** 把宿主的一份快照推给面板（就是 preload 收到 IPC 之后做的事）。 */
function pushSnapshot(snapshot: SharedListSnapshot): void {
  act(() => {
    snapshotListener?.(snapshot)
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  previewListener = undefined
  snapshotListener = undefined
  listRequests = 0
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

  it('takes tile icons from the registry, not from a UI-side list', () => {
    render(<App />)

    // claude 在注册表里有 icon，dsh 没有——面板不该自己决定谁有图标。
    const square = (name: string): Element | null =>
      screen.getByRole('button', { name }).querySelector('.abx-agent-square')

    expect(square('Claude Code：未运行，点击启动')?.getAttribute('data-icon')).toBe('claude')
    expect(square('dsh：不可用，先构建镜像')?.hasAttribute('data-icon')).toBe(false)
  })

  it('takes the image from the registry, and calls an unbuilt one unavailable', () => {
    render(<App />)

    // dsh 的镜像是 `unbuilt`（注册表里写的），所以它是「不可用」而不是「未运行」：
    // 面板要说清是哪个镜像、下一步做什么，而不是把它混进可点的那一排。
    const dsh = screen.getByRole('button', { name: 'dsh：不可用，先构建镜像' })
    expect(dsh.getAttribute('data-state')).toBe('unavailable')
    expect((dsh as HTMLButtonElement).disabled).toBe(true)
    expect(dsh.textContent).toContain('镜像未构建')
    expect(dsh.textContent).toContain('先构建镜像')
    expect(dsh.getAttribute('title')).toBe('abx-agent-dsh:unbuilt 还没构建 · 先构建镜像')

    // 另外两个构建好了：它们只是「未运行」，等着被点。
    expect(screen.getByRole('button', { name: 'Claude Code：未运行，点击启动' }).getAttribute('data-state')).toBe('idle')
    expect(screen.getByRole('button', { name: 'OpenAI Codex CLI：未运行，点击启动' }).getAttribute('data-state')).toBe(
      'idle',
    )
  })

  it('flips an agent to running when its tile is clicked', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code：未运行，点击启动' }))

    const running = screen.getByRole('button', { name: 'Claude Code：运行中，点击聚焦' })
    expect(running.getAttribute('aria-pressed')).toBe('true')
    expect(running.getAttribute('data-state')).toBe('running')
    expect(screen.getByRole('status').textContent).toContain('1 舱')
  })

  it('asks the host for the list on mount', () => {
    render(<App />)

    expect(listRequests).toBe(1)
  })

  it('renders the host snapshot: base name, kind, and read-only badge', () => {
    render(<App />)

    pushSnapshot({
      entries: [
        { path: '/Users/alain/specs/design-spec.pdf', kind: 'file', missing: false },
        { path: '/Users/alain/projects/notes', kind: 'directory', missing: false },
      ],
      rejected: [],
    })

    expect(screen.getByText('2 项')).toBeTruthy()
    expect(screen.getByText('design-spec.pdf')).toBeTruthy()
    expect(screen.getByText('notes')).toBeTruthy()
    // kind 来自宿主：目录与文件各是各的符号，读屏也读得到。
    expect(screen.getByLabelText('目录').textContent).toBe('◰')
    expect(screen.getByLabelText('文件').textContent).toBe('▤')
    expect(screen.getAllByText('只读')).toHaveLength(2)
  })

  it('marks an entry whose file is gone as 已失效 instead of dropping it from the list', () => {
    render(<App />)

    pushSnapshot({
      entries: [{ path: '/Users/alain/specs/gone.md', kind: 'file', missing: true }],
      rejected: [],
    })

    expect(screen.getByText('gone.md')).toBeTruthy()
    expect(screen.getByText('已失效')).toBeTruthy()
  })

  it('shows a dropped entry as a preview right away, then lets the host snapshot replace it', () => {
    render(<App />)

    act(() => {
      previewListener?.([{ path: '/Users/alain/notes', kind: 'directory' }])
    })

    // 预览：图标按浏览器给的那份先画出来，但徽标说的是「还没确认」。
    expect(screen.getByText('notes')).toBeTruthy()
    expect(screen.getByText('加入中')).toBeTruthy()
    expect(screen.queryByText('只读')).toBeNull()

    pushSnapshot({
      entries: [{ path: '/Users/alain/notes', kind: 'file', missing: false }],
      rejected: [],
    })

    // 宿主说它是文件——预览猜错了也就错这一下，最终以宿主为准。
    expect(screen.getByLabelText('文件').textContent).toBe('▤')
    expect(screen.getByText('只读')).toBeTruthy()
    expect(screen.queryByText('加入中')).toBeNull()
  })

  it('drops a preview that the host rejected, and says why under the shared area', () => {
    render(<App />)

    act(() => {
      previewListener?.([{ path: '/Users/alain/notes', kind: 'directory' }])
    })
    expect(screen.getByText('notes')).toBeTruthy()

    pushSnapshot({
      entries: [],
      rejected: [{ path: '/Users/alain/notes', reason: '目录里有凭据文件：.env 命中 *.env（共 1 个）。整个目录被拒绝。' }],
    })

    // 被拒的条目**不进列表**：列在那儿就等于说它共享上了。
    // （名字下面那行「未加入共享区的条目」里还会出现一次，那是原因那一栏，不是列表。）
    expect(screen.queryByLabelText('共享条目')).toBeNull()
    expect(screen.getByText('1 项未加入共享区')).toBeTruthy()
    expect(screen.getByText('目录里有凭据文件：.env 命中 *.env（共 1 个）。')).toBeTruthy()
    // 共享区空了，拖放区回到空态文案。
    expect(screen.getByText('把文件拖到托盘图标，或拖到这里')).toBeTruthy()
  })
})
