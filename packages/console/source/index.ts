// @abx/console —— UI 层。
//
// 目前只有一个界面：托盘面板（React 自绘的无边框浮层）。产物由 `vite build` 打到
// `output/`，`apps/app` 以 `file://` 加载；面板只通过 preload 的极小桥接与宿主通信
// （见 `./bridge.ts`），不直接碰文件系统或进程。
export { App } from './App'
export { getBridge, type AbxBridge } from './bridge'
export { useReportHeight } from './hooks/useReportHeight'
