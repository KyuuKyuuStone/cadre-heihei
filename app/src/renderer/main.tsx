import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/themes.css'
import './styles/app.css'
import { App } from './app/App.tsx'
import { CadreApiProvider } from './data/CadreApiProvider.tsx'
import { LocaleProvider } from './i18n/LocaleProvider.tsx'
import { ThemeProvider } from './theme/ThemeProvider.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在')

createRoot(root).render(
  <StrictMode>
    <CadreApiProvider>
      <ThemeProvider>
        <LocaleProvider>
          <App />
        </LocaleProvider>
      </ThemeProvider>
    </CadreApiProvider>
  </StrictMode>,
)
