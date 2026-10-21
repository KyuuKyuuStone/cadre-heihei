import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../../src/renderer/app/App.tsx'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import { LocaleProvider, useLocale } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { ThemeProvider, useTheme } from '../../../src/renderer/theme/ThemeProvider.tsx'
import { createFakeCadreApi, fakeFailure } from '../data/fake-api.ts'

function Probe() {
  const { theme } = useTheme()
  const { locale } = useLocale()
  return <span data-testid="probe">{theme}:{locale}</span>
}

describe('偏好：主进程权威 + localStorage 缓存', () => {
  it('prefs:get 覆盖启动缓存（主题与语言）', async () => {
    const api = createFakeCadreApi({
      getPreferences: async () => ({ ok: true, locale: 'jp', theme: 'dark' }),
    })
    render(
      <CadreApiProvider api={api}>
        <ThemeProvider initialTheme="white">
          <LocaleProvider initialLocale="zh">
            <Probe />
          </LocaleProvider>
        </ThemeProvider>
      </CadreApiProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('dark:jp')
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('prefs:set 失败时保留旧值并提示', async () => {
    const api = createFakeCadreApi({
      getPreferences: async () => ({ ok: true, locale: 'zh', theme: 'white' }),
      setPreferences: async () => fakeFailure('INTERNAL_ERROR', '保存失败'),
    })
    render(
      <CadreApiProvider api={api}>
        <ThemeProvider>
          <LocaleProvider>
            <App />
          </LocaleProvider>
        </ThemeProvider>
      </CadreApiProvider>,
    )

    await screen.findByRole('button', { name: '会话流' })
    fireEvent.change(screen.getByTestId('locale-select'), { target: { value: 'en' } })

    await waitFor(() => {
      expect(screen.getByTestId('prefs-error')).toBeTruthy()
    })
    // 失败不应用新值：界面仍是中文。
    expect(screen.getByRole('button', { name: '会话流' })).toBeTruthy()
    expect(screen.getByTestId('prefs-error').textContent).toContain('偏好保存失败')
  })
})
