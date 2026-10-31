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
  elapsedMs: null,
  heartbeatAt: null,
  firstTokenAt: null,
  tokensSoFar: null,
  stallBasis: null,
  inferred: false,
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

function openInternalActions(): void {
  fireEvent.click(button('显示内部操作'))
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
  it('renders one single-line stall strip without title or actions', () => {
    render(<CadreStallCard {...props()} />)
    expect(screen.getByText(/已停摆 · 12 分钟无活动/)).toBeTruthy()
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.queryByText('修复登录失败')).toBeNull()
    expect(screen.queryByText(/走查前端（员工）/)).toBeNull()
    expect(document.querySelector('[data-episode-id]')).toBeNull()
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull()
  })

  it('nudges in one click and refreshes the view', async () => {
    const p = props()
    render(<CadreStallCard {...p} />)
    openInternalActions()
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
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull()
    openInternalActions()
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
    openInternalActions()
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
    openInternalActions()
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
    openInternalActions()
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
    openInternalActions()
    fireEvent.click(screen.getByRole('button', { name: '催办' }))
    expect((await screen.findByRole('alert')).textContent).toContain('PERMISSION_DENIED · 只有主管可以操作')
    expect(screen.getByText('修复登录失败')).toBeTruthy()
  })

  it('renders at most one status strip for duplicate episodes', () => {
    const duplicate = { ...TASK, title: '重复通知' }
    render(<CadreStallCard {...props(stallState([TASK, duplicate]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
  })

  it('renders one generation strip without detail or heartbeat', () => {
    const generating: CadreStallTaskView = {
      ...TASK,
      stallState: 'normal',
      elapsedMs: 180_000,
      heartbeatAt: NOW - 30_000,
      firstTokenAt: NOW - 60_000,
      tokensSoFar: 128,
      stallBasis: {
        kind: 'model_generation',
        since: new Date(NOW - 180_000).toISOString(),
        stepKind: 'model_generation',
        toolName: null,
        elapsedMs: 180_000,
        heartbeatAgeMs: 30_000,
        evidenceEventSeq: 10,
      },
      inferred: true,
    }
    render(<CadreStallCard {...props(stallState([generating]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.getByText(/生成中 · 3 分钟/)).toBeTruthy()
    expect(screen.queryByText(/心跳/)).toBeNull()
    expect(screen.queryByText(/128 tokens/)).toBeNull()
    expect(screen.queryByText('修复登录失败')).toBeNull()
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull()
  })

  it('renders one tool strip with tool name and elapsed time', () => {
    const tool: CadreStallTaskView = {
      ...TASK,
      stallState: 'normal',
      elapsedMs: 210_000,
      heartbeatAt: NOW - 15_000,
      stallBasis: {
        kind: 'tool_execution',
        since: new Date(NOW - 210_000).toISOString(),
        stepKind: 'tool_execution',
        toolName: 'office_docx',
        elapsedMs: 210_000,
        heartbeatAgeMs: 15_000,
        evidenceEventSeq: 11,
      },
    }
    render(<CadreStallCard {...props(stallState([tool]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.getByText(/工具执行中 · office_docx · 已等 3 分钟/)).toBeTruthy()
    expect(screen.queryByText(/心跳/)).toBeNull()
  })

  it('keeps a long generation as a non-actionable strip', () => {
    const generating: CadreStallTaskView = {
      ...TASK,
      elapsedMs: 600_000,
      stallBasis: {
        kind: 'model_generation',
        since: new Date(NOW - 600_000).toISOString(),
        stepKind: 'model_generation',
        toolName: null,
        elapsedMs: 600_000,
        heartbeatAgeMs: 60_000,
        evidenceEventSeq: 12,
      },
    }
    render(<CadreStallCard {...props(stallState([generating]))} />)
    expect(screen.getByText(/生成中 · 10 分钟/)).toBeTruthy()
    expect(screen.queryByText(/已停摆 ·/)).toBeNull()
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull()
  })

  it('keeps waiting_question in the single status strip', () => {
    const waiting: CadreStallTaskView = {
      ...TASK,
      stallState: 'waiting_question',
      elapsedMs: 46_000,
      stallBasis: {
        kind: 'no_events',
        since: new Date(NOW - 46_000).toISOString(),
        stepKind: null,
        toolName: null,
        elapsedMs: 46_000,
        heartbeatAgeMs: 0,
        evidenceEventSeq: null,
      },
    }
    render(<CadreStallCard {...props(stallState([waiting]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.getByText(/等待回答 · 46 秒/)).toBeTruthy()
    expect(screen.queryByText(/已停摆 ·/)).toBeNull()
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull()
  })

  it('shows a write-guard error as a single error strip', () => {
    const denied: CadreStallTaskView = {
      ...TASK,
      stallState: 'normal',
      lastError: {
        code: 'WRITE_EXTENSION_DENIED',
        message: '只允许 .md/.txt',
        at: '2026-10-30T03:00:00.000Z',
      },
    }
    render(<CadreStallCard {...props(stallState([denied]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.getByText('最近错误')).toBeTruthy()
    expect(screen.queryByText('WRITE_EXTENSION_DENIED')).toBeNull()
    expect(screen.queryByText('只允许 .md/.txt')).toBeNull()
  })

  it('shows a non-guard lastError as a single error strip', () => {
    const failed: CadreStallTaskView = {
      ...TASK,
      stallState: 'normal',
      lastError: { code: 'TOOL_FAILED', message: '工具失败', at: '2026-10-30T03:00:00.000Z' },
    }
    render(<CadreStallCard {...props(stallState([failed]))} />)
    expect(document.querySelectorAll('[data-status-strip]')).toHaveLength(1)
    expect(screen.getByText('最近错误')).toBeTruthy()
    expect(screen.queryByText('TOOL_FAILED')).toBeNull()
    expect(screen.queryByText(/已停摆 ·/)).toBeNull()
  })

  it('does not render in an employee session', () => {
    render(<CadreStallCard {...props(stallState(), { sessionId: 'w1' })} />)
    expect(screen.queryByText('修复登录失败')).toBeNull()
  })
})
