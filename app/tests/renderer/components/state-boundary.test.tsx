import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { StateBoundary } from '../../../src/renderer/components/StateBoundary.tsx'
import type { ViewState } from '../../../src/renderer/components/viewState.ts'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'

function renderWithLocale(ui: ReactNode) {
  return render(<LocaleProvider initialLocale="zh">{ui}</LocaleProvider>)
}

describe('StateBoundary 八态分流', () => {
  it('empty 显示 reason/hint，使用 status 语义且绝不复用 error 样式', () => {
    const state: ViewState<null> = {
      status: 'empty',
      reason: '当前项目没有可派活的员工。',
      hint: '添加员工或切换项目。',
    }
    const { container } = renderWithLocale(
      <StateBoundary state={state} emptyTitle="暂无可用员工" renderReady={() => null} />,
    )

    expect(screen.getByText('暂无可用员工')).toBeTruthy()
    expect(screen.getByText(state.reason)).toBeTruthy()
    expect(screen.getByText(state.hint)).toBeTruthy()

    const empty = container.querySelector('[data-state="empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.className).toContain('state--empty')
    expect(empty?.className).not.toContain('state--error')
    expect(empty?.getAttribute('role')).toBe('status')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('error 用 alert 语义并保留错误码与重试入口', () => {
    const state: ViewState<null> = {
      status: 'error',
      message: '本地服务不可达',
      code: 'NETWORK',
      retryable: true,
    }
    const { container } = renderWithLocale(
      <StateBoundary state={state} renderReady={() => null} onRetry={() => {}} />,
    )

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(screen.getByText('本地服务不可达')).toBeTruthy()
    expect(screen.getByText('NETWORK')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('denied 单独成态，不与 error 共用样式', () => {
    const { container } = renderWithLocale(
      <StateBoundary
        state={{ status: 'denied', message: '跨项目不可用', code: 'CROSS_PROJECT' }}
        renderReady={() => null}
      />,
    )

    const denied = container.querySelector('[data-state="denied"]')
    expect(denied).not.toBeNull()
    expect(denied?.className).toContain('state--denied')
    expect(denied?.className).not.toContain('state--error')
  })

  it('truncated 显示已截断行数并保留内容', () => {
    renderWithLocale(
      <StateBoundary
        state={{
          status: 'truncated',
          data: { text: '工具输出摘要' },
          truncated: { totalLines: 120, shownLines: 30, outputFile: '/tmp/out.log' },
        }}
        renderReady={(data) => <p>{data.text}</p>}
      />,
    )

    expect(screen.getByText('工具输出摘要')).toBeTruthy()
    expect(screen.getByText('输出已截断（共 120 行）')).toBeTruthy()
    expect(screen.getByText('/tmp/out.log')).toBeTruthy()
  })
})
