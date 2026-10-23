// @vitest-environment jsdom

import type { SharedEntry, SharedListSnapshot } from '@abx/contracts'
import { AGENT_DEFINITIONS, AGENT_IMAGE_UNBUILT } from '@abx/contracts/agents'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { AbxBridge } from './bridge'

/*
 * 面板在 jsdom 里渲染，断言的是**用户能看到与读屏能读到的东西**：
 * 空态文案、agent 方块的可访问名与 `aria-pressed`、只显示已安装的 agent、
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
  it('renders the empty drop hint, and no cell-count pill in the header', () => {
    const { container } = render(<App />)

    // 文案只说面板：拖到**托盘图标**是 macOS only，面板内的正文不提它（`tray-ui.md` §7 第 3 条）。
    expect(screen.getByText('拖到这里 → 全部 agent 立刻可见')).toBeTruthy()
    // 「N 舱」胶囊按 `design-system.md` §8 去掉了：副标题说的是在不在跑，
    // 数量是管理面板的职责。这里把「它不在了」写下来，免得哪天又被顺手加回来。
    expect(screen.queryByText(/\d+ 舱/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()

    // 副标题是面板上唯一一句状态。它说**后果**，不说术语也不说数量
    // （`functional-design.md` §0.2 ②）——曾经逐字是「气闸待启动 · 凭据全部在舱外」，
    // 这一条守着那次改动：三个词一个都不许回来，数字同样。
    const subtitle = container.querySelector('.abx-title-sub')?.textContent ?? ''
    expect(subtitle).toBe('把文件拖进来，它就开始干活')
    expect(subtitle).not.toMatch(/气闸|凭据|舱|\d/)
  })

  it('renders one start button per installed agent, with an accessible name and pressed state', () => {
    render(<App />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Claude Code · 未运行，点击启动')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
  })

  it('takes tile icons from the registry, not from a UI-side list', () => {
    render(<App />)

    // 图标来自注册表：面板不该自己决定谁长什么样，也不该在这里另抄一份清单。
    // 镜像还没构建的 agent 进不了这一排，所以拿注册表现算一遍期望值。
    const installed = AGENT_DEFINITIONS.filter((agent) => agent.image.version !== AGENT_IMAGE_UNBUILT)
    const marks = screen
      .getAllByRole('button')
      .map((button) => button.querySelector('.abx-agent-mark')?.getAttribute('data-icon') ?? null)

    expect(marks).toEqual(installed.map((agent) => agent.icon?.slug ?? null))
  })

  it('leaves out the agents whose image is not built yet', () => {
    render(<App />)

    // dsh 的镜像是 `unbuilt`（注册表里写的），它**整个不进托盘**：这一排只有图标，
    // 而一个图标代表不了一个还没装的 agent——既没有可辨认的身份，也没有可执行的动作
    // （`tray-ui.md` §3.1 ④）。
    const unbuilt = AGENT_DEFINITIONS.filter((agent) => agent.image.version === AGENT_IMAGE_UNBUILT)
    // 这条用例不能空转：注册表里真有没构建的 agent，下面那句才验证得到东西。
    expect(unbuilt.length).toBeGreaterThan(0)

    for (const agent of unbuilt) {
      expect(screen.queryByRole('button', { name: new RegExp(agent.label) })).toBeNull()
    }
    expect(screen.getAllByRole('button')).toHaveLength(AGENT_DEFINITIONS.length - unbuilt.length)
  })

  it('flips an agent to running when its tile is clicked', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · 未运行，点击启动' }))

    const running = screen.getByRole('button', { name: 'Claude Code · 运行中，点击聚焦' })
    expect(running.getAttribute('aria-pressed')).toBe('true')
    expect(running.getAttribute('data-state')).toBe('running')
    // 在跑这一档说的是「它拿不到你的密钥」——这句话是产品承诺，也是这一档唯一的
    // 状态出口：没有数字，没有「气闸」「凭据」这些词（`design-system.md` §8 把数量
    // 判给了管理面板，`functional-design.md` §0.2 ② 要求把术语换算成后果）。
    expect(screen.getByText('运行中 · 它拿不到你的密钥')).toBeTruthy()
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
    expect(screen.getByText('拖到这里 → 全部 agent 立刻可见')).toBeTruthy()
  })
})
