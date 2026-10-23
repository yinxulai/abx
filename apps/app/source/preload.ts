// preload：渲染层唯一能碰到宿主的通道。
// 只暴露托盘面板需要的那几件事，**不暴露任何文件系统或进程能力**——
// 面板是拿来显示共享区状态的，不是拿来做事的：路径的取舍、能不能挂、
// 挂到舱内哪儿，全在宿主那一侧定。
//
// 拖放的拾取装在这里而不是渲染层：HTML5 的 `File` 只是浏览器的句柄，
// 真正的绝对路径只能由 `webUtils.getPathForFile()` 换出来，而那是宿主能力。
// DOM 事件与页面共享，所以在 preload 的隔离世界里监听既不越界，也不用往页面注入脚本。
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SharedEntry, SharedListSnapshot } from '@abx/contracts'
import { collectDroppedItems } from './drop-entry'

/** 与 `@abx/console` 的 `source/bridge.ts` 一一对应，两边改动必须同步。 */
export interface AbxBridge {
  /** 渲染层量完卡片高度后上报（不含窗口四周的透明留白），宿主据此调整窗口。 */
  reportPanelHeight(height: number): void
  /** 订阅拖入面板的条目（宿主 stat 之前的**即时预览**），返回退订函数。 */
  onDroppedEntries(callback: (entries: readonly SharedEntry[]) => void): () => void
  /** 订阅宿主给出的共享区快照（权威的那一份），返回退订函数。 */
  onSharedList(callback: (snapshot: SharedListSnapshot) => void): () => void
  /** 主动要一次快照。面板刚挂载时调它，之后靠拖入与它自己的动作更新。 */
  requestSharedList(): void
  /** 面板隐藏（点外部或按 Esc）。 */
  hide(): void
}

const droppedListeners = new Set<(entries: readonly SharedEntry[]) => void>()
const listListeners = new Set<(snapshot: SharedListSnapshot) => void>()

const bridge: AbxBridge = {
  reportPanelHeight: (height) => ipcRenderer.send('panel:height', height),
  onDroppedEntries: (callback) => {
    droppedListeners.add(callback)
    return () => {
      droppedListeners.delete(callback)
    }
  },
  onSharedList: (callback) => {
    listListeners.add(callback)
    return () => {
      listListeners.delete(callback)
    }
  },
  requestSharedList: () => {
    void requestSnapshot('shared:list', undefined)
  },
  hide: () => ipcRenderer.send('panel:hide'),
}

/**
 * 一次拖放里落在面板上的条目，按出现顺序去重。
 *
 * 两个来源要合起来看：`items` 能给 `webkitGetAsEntry()`（也就是「是文件还是目录」），
 * `files` 只在少数来源下才填。所以优先走 `items`，空了再退回 `files`
 * （那时没有 isDirectory 可用，一律按文件预览——宿主的 stat 会纠正它）。
 */
function droppedEntries(event: DragEvent): readonly SharedEntry[] {
  const dataTransfer = event.dataTransfer
  if (dataTransfer === null) return []

  const items = Array.from(dataTransfer.items)
  if (items.length > 0) {
    return collectDroppedItems(
      items.map((item) => ({ entry: item.webkitGetAsEntry(), file: item.getAsFile() })),
      (file) => webUtils.getPathForFile(file),
    )
  }

  return collectDroppedItems(
    Array.from(dataTransfer.files).map((file) => ({ entry: null, file })),
    (file) => webUtils.getPathForFile(file),
  )
}

/** 向宿主要一次共享区快照，拿到就通知渲染层。 */
async function requestSnapshot(channel: string, payload: unknown): Promise<void> {
  const snapshot = (await ipcRenderer.invoke(channel, payload)) as SharedListSnapshot
  for (const listener of listListeners) listener(snapshot)
}

// 不 preventDefault 的话，浏览器会把「拖进窗口」当成一次导航，drop 根本不会派发。
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => {
  event.preventDefault()
  const entries = droppedEntries(event)
  if (entries.length === 0) return
  // 先把预览推给渲染层（图标立刻出现），再让宿主去 stat、去判能不能挂。
  // 权威结果回来时面板会被整份快照覆盖，包括「哪几条没进列表、为什么」。
  for (const listener of droppedListeners) listener(entries)
  void requestSnapshot('shared:add', entries)
})

contextBridge.exposeInMainWorld('abx', bridge)
