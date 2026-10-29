// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CadreLedgerOverlay, isCadreTaskOverdue } from '../src/client/CadreLedgerOverlay.tsx'
import type { CadreStallState } from '../src/client/cadre-stall.ts'
import { zh, type SidebarKey } from '../src/client/locales.ts'

type Props = ComponentProps<typeof CadreLedgerOverlay>

const REQUEST = { projectId: 'p1', label: '项目部 A', cwd: '/tmp/a', token: 1 }
const EMPTY_STALL: CadreStallState = { byProject: new Map(), bySession: new Map() }
const useStall = ((selector: (value: CadreStallState) => unknown) => selector(EMPTY_STALL)) as never
const t = ((key: SidebarKey, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}) as never

function stalledView(): CadreStallState {
  return {
    byProject: new Map([['p1', {
      status: 'ready',
      tasks: [{
        taskId: 'task-1',
        title: '逾期任务',
        taskStatus: 'in_progress',
        assigneeSessionId: 's1',
        assigneeName: '前端',
        assigneeRole: 'worker',
        lastActivityAt: Date.now() - 5 * 60_000,
        lastActivityKind: 'tool',
        silenceMs: 5 * 60_000,
        stallState: 'stalled',
        stateSince: Date.now() - 5 * 60_000,
        episodeId: 'task-1:episode',
        nudgeCount: 1,
        lastNudgedAt: Date.now() - 60_000,
        suggestedAction: 'nudge',
        capabilities: { nudge: true, reassign: true, cancel: true, escalate: true },
        version: 3,
        stale: false,
        updatedAt: '2026-10-29T08:00:00.000Z',
      }],
      thresholds: {
        suspectAfterMs: 180_000, stalledAfterMs: 600_000, recoverAfterMs: 30_000,
        scanIntervalMs: 15_000, consecutiveSamples: 2, nudgeCooldownMs: 60_000,
        escalateAfterMs: 1_800_000, maxGoalRounds: 20,
      },
      stale: false,
      error: null,
    }]]),
    bySession: new Map(),
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    title: '逾期任务',
    status: 'in_progress',
    assigneeSessionId: 's1',
    assigneeName: '前端',
    updatedAt: '2026-10-28T10:00:00+08:00',
    dueAt: '2020-01-01T00:00:00+08:00',
    ...overrides,
  }
}

function mount(rows: readonly unknown[], stallState: CadreStallState = EMPTY_STALL) {
  const listTasks = vi.fn(async () => ({ rows, elapsedMs: 1 }))
  ;(window as unknown as { cadre: unknown }).cadre = { listTasks }
  const useStallForTest = ((selector: (value: CadreStallState) => unknown) => selector(stallState)) as never
  return render(<CadreLedgerOverlay {...({
    useRequest: (selector: (value: typeof REQUEST) => unknown) => selector(REQUEST),
    useStall: useStallForTest,
    closeLedger: vi.fn(),
    retryStall: vi.fn(),
    t,
  } as unknown as Props)} />)
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { cadre?: unknown }).cadre
})

describe('CadreLedgerOverlay overdue state', () => {
  it('marks a past due task and keeps a future due task unmarked', async () => {
    expect(isCadreTaskOverdue('2020-01-01T00:00:00+08:00', Date.now())).toBe(true)
    expect(isCadreTaskOverdue('2999-01-01T00:00:00+08:00', Date.now())).toBe(false)
    expect(isCadreTaskOverdue(undefined, Date.now())).toBe(false)

    mount([
      row(),
      row({ taskId: 'task-2', title: '未来任务', dueAt: '2999-01-01T00:00:00+08:00' }),
    ])
    expect(await screen.findByText('逾期任务')).toBeTruthy()
    expect(screen.getByText('已超期')).toBeTruthy()
    expect(document.querySelector('[data-overdue="true"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-overdue="true"]')).toHaveLength(1)
  })

  it('shows the ledger empty state', async () => {
    mount([])
    expect(await screen.findByText('这个项目部还没有台账记录。')).toBeTruthy()
  })

  it('joins the host stall view to the task row', async () => {
    mount([row()], stalledView())
    expect(await screen.findByText(/已停摆 · 5 分钟前/)).toBeTruthy()
    expect(document.querySelector('[data-stall-state="stalled"]')).toBeTruthy()
  })

  it('shows a read failure instead of an empty ledger', async () => {
    ;(window as unknown as { cadre: unknown }).cadre = {
      listTasks: async () => { throw new Error('read failed') },
    }
    render(<CadreLedgerOverlay {...({
      useRequest: (selector: (value: typeof REQUEST) => unknown) => selector(REQUEST),
      useStall,
      closeLedger: vi.fn(),
      retryStall: vi.fn(),
      t,
    } as unknown as Props)} />)
    expect((await screen.findByRole('alert')).textContent).toContain('read failed')
    expect(screen.queryByText('这个项目部还没有台账记录。')).toBeNull()
  })
})
