// preload：**必须是 CJS**，不能跟主进程一起打成 ESM。
//
// 面板窗口开了 `sandbox: true`，而按 Electron 的约定，沙箱里的 preload
// 「以普通 JavaScript 运行，没有 ESM 上下文」，只认 `require('electron')`；
// ESM 预加载脚本还要求 `.mjs` 扩展名，而沙箱模式并不支持它。
// 于是这里单独出一份 CJS，扩展名用 `.cjs`（包是 `type: module`，`.js` 会被当成 ESM）。
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'output',
    lib: {
      entry: { preload: 'source/preload.ts' },
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: '[name]/index.cjs' },
    },
  },
})
