// preload：渲染层唯一能碰到宿主的通道。
// 只暴露托盘面板需要的那几件事，**不暴露任何文件系统或进程能力**——
// 面板是拿来显示状态的，不是拿来做事的。
//
// 拖放的拾取装在这里而不是渲染层：HTML5 的 `File` 只是浏览器的句柄，
// 真正的绝对路径只能由 `webUtils.getPathForFile()` 换出来，而那是宿主能力。
// DOM 事件与页面共享，所以在 preload 的隔离世界里监听既不越界，也不用往页面注入脚本。
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** 与 `@abx/console` 的 `source/bridge.ts` 一一对应，两边改动必须同步。 */
export interface AbxBridge {
  /** 渲染层量完卡片高度后上报（不含窗口四周的透明留白），宿主据此调整窗口。 */
  reportPanelHeight(height: number): void
  /** 订阅拖入面板的文件绝对路径，返回退订函数。 */
  onDroppedFiles(callback: (paths: string[]) => void): () => void
  /** 面板隐藏（点外部或按 Esc）。 */
  hide(): void
}

const listeners = new Set<(paths: string[]) => void>()

const bridge: AbxBridge = {
  reportPanelHeight: (height) => ipcRenderer.send('panel:height', height),
  onDroppedFiles: (callback) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
  hide: () => ipcRenderer.send('panel:hide'),
}

/** 一次拖放里落在面板上的**绝对路径**，按出现顺序去重。 */
function pathsFromDrop(event: DragEvent): string[] {
  const paths: string[] = []
  const files = event.dataTransfer?.files
  if (files === undefined) return paths
  for (const file of files) {
    // 不是磁盘上的文件（例如拖来的选区文本）返回空串，跳过。
    const filePath = webUtils.getPathForFile(file)
    if (filePath !== '' && !paths.includes(filePath)) paths.push(filePath)
  }
  return paths
}

// 不 preventDefault 的话，浏览器会把「拖进窗口」当成一次导航，drop 根本不会派发。
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => {
  event.preventDefault()
  const paths = pathsFromDrop(event)
  if (paths.length === 0) return
  for (const listener of listeners) listener(paths)
  ipcRenderer.send('panel:dropped-files', paths)
})

contextBridge.exposeInMainWorld('abx', bridge)
