// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreTokenPanel } from '../src/client/CadreTokenPanel.tsx'
import type { CadreTokenRequest } from '../src/client/CadreTokenTypes.ts'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  const text = zh[key]
  return params === undefined ? text : text.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}) as never

const request: CadreTokenRequest = { sessionId: 's1', projectId: 'p1', label: '主管', token: 1 }
const snapshot = {
  promptTokens: 2400, cachedTokens: 800, completionTokens: 800, totalTokens: 4000,
  rounds: [{ round: 1, promptTokens: 2400, cachedTokens: 800, completionTokens: 800, totalTokens: 4000 }],
  recent: [{ round: 1, promptTokens: 2400, cachedTokens: 800, completionTokens: 800, totalTokens: 4000 }],
}
const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response

function mount(role: 'supervisor' | 'worker' = 'supervisor') {
  const roster: CadreRosterState = {
    status: 'ready',
    error: null,
    members: [{ sessionId: 's1', role, state: 'available', displayName: '主管' }],
  }
  return render(
    <CadreTokenPanel
      useTokenRequest={((selector: (state: CadreTokenRequest | null) => unknown) => selector(request)) as never}
      useRoster={((selector: (state: CadreRosterState) => unknown) => selector(roster)) as never}
      openToken={vi.fn()}
      closeToken={vi.fn()}
      t={t}
    />,
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Cadre token panel', () => {
  it('renders the session totals and recent rounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, snapshot })))
    mount()
    expect(await screen.findByText('4,000')).toBeTruthy()
    expect(screen.getByText('2.4k')).toBeTruthy()
    expect(screen.getByText('最近 5 轮')).toBeTruthy()
    expect(screen.getByText('第 1 轮')).toBeTruthy()
  })

  it('shows budget percentages and the warning at 80%', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: true,
      snapshot: {
        promptTokens: 24000, cachedTokens: 0, completionTokens: 0, totalTokens: 24000,
        rounds: [{ round: 1, promptTokens: 24000, cachedTokens: 0, completionTokens: 0, totalTokens: 6400 }],
        recent: [{ round: 1, promptTokens: 24000, cachedTokens: 0, completionTokens: 0, totalTokens: 6400 }],
      },
    })))
    mount()
    expect(await screen.findAllByText('80%')).toHaveLength(2)
    expect(screen.getByText('已接近预算上限，建议处理：')).toBeTruthy()
    expect(screen.getByText('压缩上下文后继续')).toBeTruthy()
  })

  it('does not warn below the threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, snapshot })))
    mount()
    await screen.findByText('4,000')
    expect(screen.queryByText('已接近预算上限，建议处理：')).toBeNull()
  })

  it('renders a readable empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: true,
      snapshot: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0, rounds: [], recent: [] },
    })))
    mount()
    expect(await screen.findByText('还没有用量记录。')).toBeTruthy()
  })

  it('renders a readable error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, message: 'FORBIDDEN' }, false)))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('用量读取失败，请稍后重试。')
  })

  it('lets a supervisor query one task total', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return json({ ok: true, snapshot: { ...snapshot, totalTokens: call === 1 ? 4000 : 9000 } })
    }))
    mount('supervisor')
    await screen.findByText('4,000')
    fireEvent.change(screen.getByLabelText('任务 ID'), { target: { value: 't1' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('9,000')).toBeTruthy()
  })

  it('lets only supervisors query a task and shows the self scope for workers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, snapshot })))
    const view = mount('supervisor')
    await waitFor(() => { expect(screen.getByText('主管：可查本会话与任务')).toBeTruthy() })
    expect(screen.getByLabelText('任务 ID')).toBeTruthy()
    view.unmount()
    mount('worker')
    await waitFor(() => { expect(screen.getByText('仅显示自己的用量')).toBeTruthy() })
    expect(screen.queryByLabelText('任务 ID')).toBeNull()
  })
})
