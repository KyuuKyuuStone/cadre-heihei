// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CadreLedgerOverlay, isCadreTaskOverdue, ledgerPageWindow } from '../src/client/CadreLedgerOverlay.tsx'
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
        elapsedMs: null,
        heartbeatAt: null,
        firstTokenAt: null,
        tokensSoFar: null,
        stallBasis: null,
        inferred: false,
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

function executionView(): CadreStallState {
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
        lastActivityAt: Date.now() - 3 * 60_000,
        lastActivityKind: 'assistant',
        silenceMs: null,
        stallState: 'normal',
        stateSince: Date.now() - 3 * 60_000,
        episodeId: 'task-1:episode',
        nudgeCount: 0,
        lastNudgedAt: null,
        suggestedAction: null,
        capabilities: { nudge: false, reassign: false, cancel: false, escalate: false },
        version: 3,
        stale: false,
        updatedAt: '2026-10-29T08:00:00.000Z',
        elapsedMs: 180_000,
        heartbeatAt: Date.now() - 30_000,
        firstTokenAt: Date.now() - 60_000,
        tokensSoFar: 128,
        stallBasis: {
          kind: 'model_generation',
          since: new Date(Date.now() - 180_000).toISOString(),
          stepKind: 'model_generation',
          toolName: null,
          elapsedMs: 180_000,
          heartbeatAgeMs: 30_000,
          evidenceEventSeq: 10,
        },
        inferred: false,
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

function manyRows(): readonly Record<string, unknown>[] {
  return Array.from({ length: 95 }, (_, index) => row({
    taskId: `task-${String(index)}`,
    title: `任务 ${String(index)}`,
    status: index < 60 ? 'in_progress' : index < 80 ? 'delivered' : 'verified',
  }))
}

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

  it('renders only 20 of 95 rows and pages through the ledger', async () => {
    mount(manyRows())
    expect(await screen.findByText('任务 0')).toBeTruthy()
    expect(document.querySelectorAll('[data-ledger-row]')).toHaveLength(20)
    expect(screen.getByText('共 95 条 · 第 1/5 页')).toBeTruthy()
    expect(screen.getByRole('button', { name: '全部 95' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '进行中 60' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '待验收 20' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已完成 15' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }))
    expect(document.querySelectorAll('[data-ledger-row]')).toHaveLength(20)
    expect(screen.getByText('共 95 条 · 第 2/5 页')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '第 5 页' }))
    expect(document.querySelectorAll('[data-ledger-row]')).toHaveLength(15)
    expect(screen.getByText('共 95 条 · 第 5/5 页')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(false)
  })

  it('resets to page 1 after changing filter or search', async () => {
    mount(manyRows())
    expect(await screen.findByText('任务 0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }))
    fireEvent.click(screen.getByRole('button', { name: /进行中/ }))
    expect(screen.getByText('共 60 条 · 第 1/3 页')).toBeTruthy()
    expect(document.querySelectorAll('[data-ledger-row]')).toHaveLength(20)

    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索台账' }), { target: { value: '任务 9' } })
    expect(screen.getByText(/第 1\/1 页/)).toBeTruthy()
  })

  it('builds a bounded page window with ellipses', () => {
    expect(ledgerPageWindow(1, 10)).toEqual([1, 2, 3, 4, 'ellipsis', 10])
    expect(ledgerPageWindow(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10])
    expect(ledgerPageWindow(10, 10)).toEqual([1, 'ellipsis', 7, 8, 9, 10])
    expect(ledgerPageWindow(1, 1)).toEqual([1])
  })

  it('shows live execution progress instead of a stall state', async () => {
    mount([row()], executionView())
    expect(await screen.findByText(/生成中 · 3 分钟/)).toBeTruthy()
    expect(document.querySelector('[data-execution-state="model_generation"]')).toBeTruthy()
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
