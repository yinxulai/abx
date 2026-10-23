// 主进程与 preload 各打一份。两者运行在不同的上下文里（Node / 隔离世界），
// 不能打成一个包：preload 一旦 require 到 Node 内置模块，隔离就破了。
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'output',
    lib: {
      entry: { main: 'source/main.ts', preload: 'source/preload.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: '[name]/index.js' },
    },
  },
})
