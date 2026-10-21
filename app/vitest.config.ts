import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 组件/DOM 测试独立于 node:test；两套 runner 由 smoke 门禁分别收集（ADR-0020）。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/renderer/**/*.test.tsx'],
    setupFiles: ['./tests/renderer/vitest-setup.ts'],
  },
})
