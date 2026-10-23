import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 面板产物由 `apps/app` 用 `loadFile()` 以 `file://` 打开，所以资源引用必须是
// 相对路径：默认的 `base: '/'` 会生成 `/assets/...`，在 file:// 下直接 404。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'output',
    emptyOutDir: true,
  },
})
