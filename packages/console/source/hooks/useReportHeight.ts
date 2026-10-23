import { useEffect, type RefObject } from 'react'
import { getBridge } from '../bridge'

/**
 * 把卡片的内容高度报给宿主窗口。
 *
 * 托盘面板的高度由内容决定：窗口是固定的 422 宽，高度必须等于卡片高度加上下留白，
 * 留白多一像素就在桌面上留一条缝。所以高度的真相在 DOM 里，窗口跟着它走。
 *
 * 用 `ResizeObserver` 盯住卡片本体，而不是在数据变化后手动量一次：数据、语言、
 * 字体加载、系统缩放……能改变高度的东西太多，逐个记住去触发必然会漏。
 *
 * 报出去的是**卡片高度，不含留白**——留白由宿主 `setContentSize` 时统一加，
 * 两边各加一次就会高出一整圈。
 */
export function useReportHeight(elementRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = elementRef.current
    const bridge = getBridge()
    // 浏览器里预览面板时没有宿主可报，静默跳过。
    if (element === null || bridge === undefined) return

    // 高度没变就不报：多余的 IPC 会让窗口反复重排，贴着鼠标的浮层会抖。
    let reported = -1

    const report = (): void => {
      const height = Math.ceil(element.getBoundingClientRect().height)
      // 还没完成布局（高度为 0）时不报，避免把宿主窗口压到最小高度。
      if (height <= 0 || height === reported) return
      reported = height
      bridge.reportPanelHeight(height)
    }

    const Observer: typeof ResizeObserver | undefined = globalThis.ResizeObserver
    if (Observer === undefined) {
      report()
      return
    }

    const observer = new Observer(report)
    observer.observe(element)
    // 首帧先报一次：窗口的初始高度与内容的初始高度几乎不可能正好相等。
    report()

    return () => observer.disconnect()
  }, [elementRef])
}
