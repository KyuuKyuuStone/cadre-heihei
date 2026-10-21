import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Vite 骨架空壳：Provider / 三屏接线在 M3 步骤 4 完成。
const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在')

createRoot(root).render(
  <StrictMode>
    <div>cadre-heihei renderer booting</div>
  </StrictMode>,
)
