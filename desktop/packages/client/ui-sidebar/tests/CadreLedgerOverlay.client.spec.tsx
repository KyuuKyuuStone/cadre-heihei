// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CadreLedgerOverlay, isCadreTaskOverdue } from '../src/client/CadreLedgerOverlay.tsx'

type Props = ComponentProps<typeof CadreLedgerOverlay>

const REQUEST = { projectId: 'p1', label: '项目部 A', cwd: '/tmp/a', token: 1 }

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

function mount(rows: readonly unknown[]) {
  const listTasks = vi.fn(async () => ({ rows, elapsedMs: 1 }))
  ;(window as unknown as { cadre: unknown }).cadre = { listTasks }
  return render(<CadreLedgerOverlay {...({
    useRequest: (selector: (value: typeof REQUEST) => unknown) => selector(REQUEST),
    closeLedger: vi.fn(),
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

  it('shows a read failure instead of an empty ledger', async () => {
    ;(window as unknown as { cadre: unknown }).cadre = {
      listTasks: async () => { throw new Error('read failed') },
    }
    render(<CadreLedgerOverlay {...({
      useRequest: (selector: (value: typeof REQUEST) => unknown) => selector(REQUEST),
      closeLedger: vi.fn(),
    } as unknown as Props)} />)
    expect((await screen.findByRole('alert')).textContent).toContain('read failed')
    expect(screen.queryByText('这个项目部还没有台账记录。')).toBeNull()
  })
})
