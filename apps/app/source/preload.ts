// preload：渲染层唯一能碰到宿主的通道。
// 只暴露托盘面板需要的三件事，**不暴露任何文件系统或进程能力**——
// 面板是拿来显示状态的，不是拿来做事的。
import { contextBridge, ipcRenderer } from 'electron'

export interface AbxBridge {
  /** 渲染层量完高度后上报，宿主据此调整窗口。 */
  reportHeight(height: number): void
  /** 面板隐藏（点外部或按 Esc）。 */
  hide(): void
}

const bridge: AbxBridge = {
  reportHeight: height => ipcRenderer.send('panel:height', height),
  hide: () => ipcRenderer.send('panel:hide'),
}

contextBridge.exposeInMainWorld('abx', bridge)
