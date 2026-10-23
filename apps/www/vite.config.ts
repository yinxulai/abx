import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 与 osw 的 `apps/www` 同一套构建链：Vite + React + Tailwind v4（CSS-first，
// 没有 `tailwind.config.js`，设计令牌写在 `source/index.css` 的 `@theme` 里）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'output', emptyOutDir: true },
})
