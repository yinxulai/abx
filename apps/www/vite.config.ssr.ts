import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 预渲染用的 SSR 构建，只服务 `scripts/prerender.mjs`。
 *
 * 为什么另起一份配置：产物必须和客户端产物分开。客户端那份的 `outDir` 是
 * `output/` 且 `emptyOutDir: true`，如果 SSR 也写进去，两次构建会互相清空。
 * 这里写到 `output-ssr/`，预渲染脚本导入它之后就把目录删掉，仓库里不留产物。
 *
 * Tailwind 插件照常挂上：SSR 图里目前没有 CSS import，它什么都不产出；
 * 哪天组件开始引 CSS，也不会因为「这份配置少了插件」而变成两份不同的构建。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'output-ssr',
    emptyOutDir: true,
    ssr: 'source/entry-server.tsx',
  },
})
