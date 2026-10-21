import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer 独立构建；产物供 Electron loadFile 使用（base:'./'）。
// dev 端口与 Electron 主进程约定一致：1420 + strictPort。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
})
