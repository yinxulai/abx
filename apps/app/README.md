# @abx/app

桌面宿主。Electron 主进程 + preload，**只做宿主适配**（托盘、窗口、IPC），
领域逻辑一律住在 `@abx/core`（见 `apps/docs/specs/overview/architecture.md` §8）。

- `source/main.ts` —— 托盘图标、无边框透明面板窗口、高度 IPC、失焦隐藏、加载面板
- `source/preload.ts` —— 渲染层唯一的宿主通道：上报高度、订阅拖入的文件路径、隐藏
- 面板是**自绘窗口**，不是原生菜单（原因见 `apps/docs/specs/product/tray-ui.md`）

## 产物

`scripts/build.mjs` 依次构建三份，都落在 `output/` 下：

| 产物 | 来源 | 格式 |
|---|---|---|
| `output/panel/` | `@abx/console` | 静态 HTML/CSS/JS，`loadFile` 以 `file://` 打开 |
| `output/main/index.js` | `source/main.ts` | ESM |
| `output/preload/index.cjs` | `source/preload.ts` | CJS |

preload 单独一份配置、单独一个扩展名，是因为面板窗口开了 `sandbox: true`，
而沙箱里的 preload 没有 ESM 上下文，只认 `require('electron')`。

## 拖放

拖入面板的文件路径由 preload 监听 `drop` 后用 `webUtils.getPathForFile()` 换取，
再经 `panel:dropped-files` 交给主进程。主进程当前**只记录收到几条**——
挂载进共享区属于 mounts 作业。托盘图标上的 `drop-files` 是 macOS only，是另一条入口。

## 未验证

本机 `DISPLAY` 为空，Electron 起不来。托盘、面板定位、失焦隐藏、加载面板、
拖拽落点**全部未在真机验证**，尤其 `drop-files` 是 macOS only。
