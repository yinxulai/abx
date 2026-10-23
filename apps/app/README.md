# @abx/app

桌面宿主。Electron 主进程 + preload，**只做宿主适配**（托盘、窗口、IPC），
领域逻辑一律住在 `@abx/core`（见 `apps/docs/specs/overview/architecture.md` §8）。

- `source/main.ts` —— 托盘图标、无边框透明面板窗口、高度 IPC、失焦隐藏
- `source/preload.ts` —— 渲染层唯一的宿主通道，只暴露「上报高度」与「隐藏」
- 面板是**自绘窗口**，不是原生菜单（原因见 `apps/docs/specs/product/tray-ui.md`）

## 未验证

本机 `DISPLAY` 为空，Electron 起不来。托盘、面板定位、失焦隐藏、拖拽落点
**全部未在真机验证**，尤其 `drop-files` 是 macOS only。
