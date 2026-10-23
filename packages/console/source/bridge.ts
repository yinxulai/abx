// 渲染层能看到的宿主能力，全部由 `apps/app/source/preload.ts` 经 contextBridge 暴露。
//
// 这里重复声明一次接口而不是从宿主包里 import：面板与宿主是两个进程、两个构建，
// 面板还要能在浏览器里单独打开（那时 `window.abx` 压根不存在）。两边改动必须同步——
// 宿主侧的那份在 `apps/app/source/preload.ts`，注释里互相指名。
//
// 只有类型从 `@abx/contracts` 进来（`import type` 会被构建整个删掉）：
// 面板是浏览器包，契约的根入口里有 `node:fs` / `node:path` 的东西不能进来。
import type { SharedEntry, SharedListSnapshot } from '@abx/contracts'

export interface AbxBridge {
  /** 内容高度（不含窗口四周的透明留白），宿主会加上留白再设置窗口尺寸。 */
  reportPanelHeight(height: number): void
  /** 订阅拖入面板的条目（宿主 stat 之前的**即时预览**），返回退订函数。 */
  onDroppedEntries(callback: (entries: readonly SharedEntry[]) => void): () => void
  /** 订阅宿主给出的共享区快照（权威的那一份），返回退订函数。 */
  onSharedList(callback: (snapshot: SharedListSnapshot) => void): () => void
  /** 主动要一次快照；面板刚挂载时调它。 */
  requestSharedList(): void
  /** 收起面板（点外部或按 Esc）。 */
  hide(): void
}

declare global {
  interface Window {
    /** 只有跑在 Electron 面板窗口里才有；浏览器里为 undefined。 */
    abx?: AbxBridge
  }
}

export function getBridge(): AbxBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.abx
}
