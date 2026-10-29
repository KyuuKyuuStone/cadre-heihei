// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreStallCard } from '../src/client/CadreStallCard.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh, type SidebarKey } from '../src/client/locales.ts'
import {
  CADRE_STALL_DEFAULTS,
  summarizeStalls,
  type CadreStallActionResult,
  type CadreStallState,
  type CadreStallTaskView,
} from '../src/client/cadre-stall.ts'

type Props = ComponentProps<typeof CadreStallCard>

const NOW = Date.now()
const TASK: CadreStallTaskView = {
  taskId: 'task-1',
  title: '修复登录失败',
  taskStatus: 'in_progress',
  assigneeSessionId: 'w1',
  assigneeName: '走查前端',
  assigneeRole: 'worker',
  lastActivityAt: NOW - 12 * 60_000,
  lastActivityKind: 'tool',
  silenceMs: 12 * 60_000,
  stallState: 'stalled',
  stateSince: NOW - 10 * 60_000,
  episodeId: 'task-1:2026-10-29T08:00:00.000Z',
  nudgeCount: 0,
  lastNudgedAt: null,
  suggestedAction: 'nudge',
  capabilities: { nudge: true, reassign: true, cancel: true, escalate: true },
  version: 7,
  stale: false,
  updatedAt: '2026-10-29T08:00:00.000Z',
}

function stallState(tasks: readonly CadreStallTaskView[] = [TASK], stale = false): CadreStallState {
  return {
    byProject: new Map([['p1', {
      status: 'ready', tasks, thresholds: CADRE_STALL_DEFAULTS, stale, error: null,
    }]]),
    bySession: summarizeStalls(tasks),
  }
}

const ROSTER: CadreRosterState = {
  status: 'ready',
  members: [
    { sessionId: 'sup-1', role: 'supervisor', displayName: '主管', state: 'available' },
    { sessionId: 'w1', role: 'worker', displayName: '走查前端', description: '前端', state: 'available' },
    { sessionId: 'w2', role: 'worker', displayName: '走查后端', description: '后端', state: 'available' },
  ],
  error: null,
}

const t = ((key: SidebarKey, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}) as never

function button(name: string): HTMLButtonElement {
  const element = screen.getByRole('button', { name })
  if (!(element instanceof HTMLButtonElement)) throw new Error(`not a button: ${name}`)
  return element
}

function props(state: CadreStallState = stallState(), overrides: Partial<Props> = {}): Props {
  const useStall = ((selector: (value: CadreStallState) => unknown) => selector(state)) as never
  const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector(ROSTER)) as never
  return {
    sessionId: 'sup-1',
    projectId: 'p1',
    t,
    useStall,
    useRoster,
    nudge: vi.fn(async (): Promise<CadreStallActionResult> => ({ ok: true, action: 'nudge', version: 8, replayed: false })),
    reassign: vi.fn(async (): Promise<CadreStallActionResult> => ({ ok: true, action: 'reassign', version: 8, replayed: false })),
    cancel: vi.fn(async (): Promise<CadreStallActionResult> => ({ ok: true, action: 'cancel', version: 8, replayed: false })),
    escalate: vi.fn(async (): Promise<CadreStallActionResult> => ({ ok: true, action: 'escalate', version: 8, replayed: false })),
    refresh: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe('CadreStallCard', () => {
  it('renders one supervisor card with task, employee, silence and last activity', () => {
    render(<CadreStallCard {...props()} />)
    expect(screen.getByText(/已停摆 · 12 分钟无活动/)).toBeTruthy()
    expect(screen.getByText('修复登录失败')).toBeTruthy()
    expect(screen.getByText(/走查前端（员工）/)).toBeTruthy()
    expect(document.querySelectorAll('[data-episode-id]')).toHaveLength(1)
  })

  it('nudges in one click and refreshes the view', async () => {
    const p = props()
    render(<CadreStallCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '催办' }))
    await waitFor(() => { expect(p.nudge).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      episodeId: TASK.episodeId,
      expectedVersion: 7,
    })) })
    await waitFor(() => { expect(p.refresh).toHaveBeenCalledOnce() })
    expect(screen.getByText('已催办 · 等待回应')).toBeTruthy()
  })

  it('disables actions and says data may be stale', () => {
    const p = props(stallState([{ ...TASK, stale: true }], true))
    render(<CadreStallCard {...p} />)
    expect(screen.getByText(/数据可能过期/)).toBeTruthy()
    expect(button('催办').disabled).toBe(true)
    expect(button('重派…').disabled).toBe(true)
    expect(button('取消…').disabled).toBe(true)
    expect(button('升级给我').disabled).toBe(true)
  })

  it('shows a view error with retry', () => {
    const p = props({
      byProject: new Map([['p1', {
        status: 'error', tasks: [], thresholds: CADRE_STALL_DEFAULTS, stale: false, error: 'read failed',
      }]]),
      bySession: new Map(),
    })
    render(<CadreStallCard {...p} />)
    expect(screen.getByRole('alert').textContent).toContain('read failed')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(p.refresh).toHaveBeenCalledOnce()
  })

  it('requires a target and reason before reassigning', async () => {
    const p = props()
    render(<CadreStallCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '重派…' }))
    const confirm = button('确认重派')
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('接手员工'), { target: { value: 'w2' } })
    fireEvent.change(screen.getByLabelText('原因（必填）'), { target: { value: '换人继续' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(p.reassign).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', toSessionId: 'w2', reason: '换人继续',
    })) })
  })

  it('requires a reason before cancelling', async () => {
    const p = props()
    render(<CadreStallCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '取消…' }))
    const confirm = button('确认取消')
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('原因（必填）'), { target: { value: '需求取消' } })
    fireEvent.click(confirm)
    await waitFor(() => { expect(p.cancel).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', reason: '需求取消',
    })) })
  })

  it('escalates in one click', async () => {
    const p = props()
    render(<CadreStallCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '升级给我' }))
    await waitFor(() => { expect(p.escalate).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' })) })
  })

  it('shows a nudge failure without hiding the card', async () => {
    const p = props(stallState(), {
      nudge: vi.fn(async (): Promise<CadreStallActionResult> => ({
        ok: false, code: 'PERMISSION_DENIED', message: '只有主管可以操作',
      })),
    })
    render(<CadreStallCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '催办' }))
    expect((await screen.findByRole('alert')).textContent).toContain('PERMISSION_DENIED · 只有主管可以操作')
    expect(screen.getByText('修复登录失败')).toBeTruthy()
  })

  it('dedupes cards by episodeId', () => {
    const duplicate = { ...TASK, title: '重复通知' }
    render(<CadreStallCard {...props(stallState([TASK, duplicate]))} />)
    expect(document.querySelectorAll('[data-episode-id]')).toHaveLength(1)
  })

  it('does not render in an employee session', () => {
    render(<CadreStallCard {...props(stallState(), { sessionId: 'w1' })} />)
    expect(screen.queryByText('修复登录失败')).toBeNull()
  })
})
