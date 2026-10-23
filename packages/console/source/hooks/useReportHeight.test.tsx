// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbxBridge } from '../bridge'
import { useReportHeight } from './useReportHeight'

/*
 * 高度回报这条链路：观察卡片 → 量出像素高度 → 报给宿主。
 * 测的是「什么时候报、报多少」，所以 ResizeObserver 与 `getBoundingClientRect` 都由用例驱动。
 */

const state = vi.hoisted(() => ({
  reportPanelHeight: vi.fn<(height: number) => void>(),
  observers: [] as (() => void)[],
}))

/** 当前卡片测得的高度，用例自己改。 */
let measuredHeight = 0

class FakeResizeObserver {
  constructor(callback: () => void) {
    state.observers.push(callback)
  }

  observe(): void {}

  disconnect(): void {}
}

function makeRef() {
  const element = {
    getBoundingClientRect: () => ({ height: measuredHeight }) as DOMRect,
  }
  return { current: element as unknown as HTMLElement }
}

function installBridge(): void {
  const bridge: AbxBridge = {
    reportPanelHeight: state.reportPanelHeight,
    onDroppedFiles: () => () => {},
    hide: () => {},
  }
  Object.defineProperty(window, 'abx', { value: bridge, configurable: true })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  state.reportPanelHeight.mockClear()
  state.observers = []
  measuredHeight = 0
  installBridge()
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'abx')
})

describe('useReportHeight', () => {
  it('挂载时就把初始高度报出去', () => {
    measuredHeight = 320

    renderHook(() => useReportHeight(makeRef()))

    expect(state.reportPanelHeight).toHaveBeenCalledWith(320)
  })

  it('内容高度变化后重新上报', () => {
    measuredHeight = 320
    renderHook(() => useReportHeight(makeRef()))
    expect(state.reportPanelHeight).toHaveBeenCalledTimes(1)

    measuredHeight = 412
    for (const observer of state.observers) observer()

    expect(state.reportPanelHeight).toHaveBeenCalledTimes(2)
    expect(state.reportPanelHeight).toHaveBeenLastCalledWith(412)
  })

  it('高度取整向上，避免内容被最后 1 像素切掉', () => {
    measuredHeight = 320.2

    renderHook(() => useReportHeight(makeRef()))

    expect(state.reportPanelHeight).toHaveBeenCalledWith(321)
  })

  it('高度没变就不再上报（省掉一次无意义的窗口重排）', () => {
    measuredHeight = 320
    renderHook(() => useReportHeight(makeRef()))

    for (const observer of state.observers) observer()
    for (const observer of state.observers) observer()

    expect(state.reportPanelHeight).toHaveBeenCalledTimes(1)
  })

  it('还没完成布局（高度为 0）时不报，免得窗口被压到最小', () => {
    measuredHeight = 0

    renderHook(() => useReportHeight(makeRef()))

    expect(state.reportPanelHeight).not.toHaveBeenCalled()
  })

  it('浏览器形态（没有宿主桥）下静默跳过', () => {
    Reflect.deleteProperty(window, 'abx')
    measuredHeight = 320

    renderHook(() => useReportHeight(makeRef()))

    expect(state.reportPanelHeight).not.toHaveBeenCalled()
  })

  it('卸载时断开观察', () => {
    const disconnect = vi.fn()
    class TrackedObserver {
      constructor(callback: () => void) {
        state.observers.push(callback)
      }

      observe(): void {}

      disconnect(): void {
        disconnect()
      }
    }
    vi.stubGlobal('ResizeObserver', TrackedObserver)
    measuredHeight = 200

    const { unmount } = renderHook(() => useReportHeight(makeRef()))
    unmount()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
