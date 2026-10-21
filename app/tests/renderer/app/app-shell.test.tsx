import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../../src/renderer/app/App.tsx'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { THEMES, ThemeProvider } from '../../../src/renderer/theme/ThemeProvider.tsx'

function renderApp() {
  return render(
    <ThemeProvider initialTheme="white">
      <LocaleProvider initialLocale="zh">
        <App />
      </LocaleProvider>
    </ThemeProvider>,
  )
}

describe('App 三屏骨架', () => {
  it('三屏导航可切换，默认落在会话流空态', () => {
    renderApp()
    expect(screen.getByText('还没有消息')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '任务台账' }))
    expect(screen.getByText('还没有任务')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '花名册' }))
    expect(screen.getByText('暂无可用员工')).toBeTruthy()
    expect(screen.getByTestId('roster-scope').textContent).toContain('全局在册：0')
    expect(screen.getByTestId('roster-scope').textContent).toContain('本项目可用：0')
  })

  it('六主题切换均写入 html data-theme', () => {
    renderApp()
    const select = screen.getByTestId('theme-select')
    for (const theme of THEMES) {
      fireEvent.change(select, { target: { value: theme } })
      expect(document.documentElement.dataset.theme).toBe(theme)
    }
  })

  it('五语切换更新界面文案', () => {
    renderApp()
    const select = screen.getByTestId('locale-select')
    const cases: Array<[string, string]> = [
      ['en', 'Conversation'],
      ['zh', '会话流'],
      ['zh-TW', '會話流'],
      ['jp', '会話'],
      ['kr', '대화'],
    ]
    for (const [locale, label] of cases) {
      fireEvent.change(select, { target: { value: locale } })
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })
})
