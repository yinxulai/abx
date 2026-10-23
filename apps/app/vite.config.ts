// 主进程：ESM（`package.json` 里 `type: module`，`main` 指向 `output/main/index.js`）。
// preload 单独有一份配置，因为它必须是 CJS —— 原因写在 `vite.preload.config.ts`。
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'output',
    lib: {
      entry: { main: 'source/main.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      // `node:*` 必须显式列为 external：lib 模式默认按浏览器平台构建，会把 Node 内置
      // 模块替换成空对象（只给一条 "externalized for browser compatibility" 警告），
      // 于是 `path.join` / `fileURLToPath` 到运行时才变成 undefined。主进程跑在 Node 上，
      // 这些 import 要原样留给 Electron 解析。
      external: ['electron', 'node:path', 'node:url'],
      output: { entryFileNames: '[name]/index.js' },
    },
  },
})
