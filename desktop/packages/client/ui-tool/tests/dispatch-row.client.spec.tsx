// @vitest-environment jsdom
/** W2 dispatch status row: structured meta, retryable failures, legacy fallback. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DispatchStatusRow, type RetryOutcome } from '../src/client/tool/toolviews/dispatch-row.tsx'

type Props = Parameters<typeof DispatchStatusRow>[0]

interface Meta {
  dispatched: { taskId: string; assigneeName: string; role: string; dueAt: string }[]
  failed: { target: string; reason: string; retryable: boolean; pendingId?: string }[]
}

const DISPATCHED = [
  { taskId: 'task-1', assigneeName: '陈允', role: 'worker', dueAt: '2026-10-25T18:00:00+08:00' },
  { taskId: 'task-2', assigneeName: '陈允', role: 'worker', dueAt: '2026-10-25T18:00:00+08:00' },
  { taskId: 'task-3', assigneeName: '沈青', role: 'worker', dueAt: '2026-10-25T18:00:00+08:00' },
]

function result(meta: Meta | undefined, text = ''): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 10,
    time: 2000,
    callTime: 1000,
    callId: 'c1',
    name: 'dispatch_task',
    args: PartialArguments.fromText('{}'),
    call: { name: 'dispatch_task', argsRaw: '{}' },
    content: [{ type: 'text', text }],
    isError: false,
    ...(meta === undefined ? {} : { meta }),
    subCalls: [],
  }
}

function props(overrides: Record<string, unknown>): Props {
  return {
    phase: 'result',
    block: result({ dispatched: [], failed: [] }),
    sessionId: 's1',
    retry: vi.fn(async (): Promise<RetryOutcome> => ({ ok: true })),
    ...overrides,
  } as unknown as Props
}

beforeEach(() => {
  delete (window as unknown as { cadre?: unknown }).cadre
})
afterEach(cleanup)

describe('DispatchStatusRow', () => {
  it('shows 拆解中 while the call has no result', () => {
    render(<DispatchStatusRow {...props({
      phase: 'start',
      block: {
        phase: 'start', name: 'dispatch_task', callId: 'c1',
        args: PartialArguments.fromText('{}'), argsRaw: '{}', turn: 1, step: 1, time: 1, subCalls: [],
      },
    })} />)
    expect(screen.getByText('拆解中…')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  it('groups meta.dispatched by assignee without reading the rendered text', () => {
    render(<DispatchStatusRow {...props({
      block: result({ dispatched: DISPATCHED, failed: [] }, '文案随意改都无所谓'),
    })} />)
    expect(screen.getByText('已派给 陈允（2 条） · 沈青（1 条）')).toBeTruthy()
    expect(screen.getByText(/^共 3 条任务 · 截止 /)).toBeTruthy()
    expect(screen.getByText('陈允 · task-1')).toBeTruthy()
    expect(screen.getByText('沈青 · task-3')).toBeTruthy()
  })

  it('retries a retryable failure by pendingId and updates the bar to dispatched', async () => {
    const retry = vi.fn(async (): Promise<RetryOutcome> => ({
      ok: true,
      dispatched: [{ taskId: 'task-4', assigneeName: '沈青', role: 'worker', dueAt: '2026-10-25T18:00:00+08:00' }],
      failed: [],
    }))
    render(<DispatchStatusRow {...props({
      block: result({
        dispatched: DISPATCHED.slice(0, 2),
        failed: [{ target: '沈青', reason: '待派：本项目没有找到员工：沈青', retryable: true, pendingId: 'pending-1' }],
      }),
      retry,
    })} />)
    expect(screen.getByText('部分成功 · 成功 2 条 · 失败 1 条')).toBeTruthy()
    expect(screen.getByText('待派')).toBeTruthy()
    expect(screen.getByText('补人后可重试')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledWith('pending-1')
    await waitFor(() => { expect(screen.getByText('已派给 陈允（2 条） · 沈青（1 条）')).toBeTruthy() })
    expect(screen.queryByText('待派')).toBeNull()
    expect(screen.getByText('沈青 · task-4')).toBeTruthy()
  })

  it('disables the button when retryable is false and never calls retry', () => {
    const retry = vi.fn(async (): Promise<RetryOutcome> => ({ ok: true }))
    render(<DispatchStatusRow {...props({
      block: result({
        dispatched: [],
        failed: [{ target: '陈允', reason: 'dueAt 不是合法时间：明天', retryable: false }],
      }),
      retry,
    })} />)
    const button = screen.getByRole('button', { name: '重试' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toBe('该失败不可重试，请重新派活')
    fireEvent.click(button)
    expect(retry).not.toHaveBeenCalled()
  })

  it('shows a decomposition failure with its reason and no task rows', () => {
    render(<DispatchStatusRow {...props({
      block: { ...result(undefined, '拆解失败：tasks 至少一条，请重新拆解后再派'), isError: true },
    })} />)
    expect(screen.getByText('拆解失败')).toBeTruthy()
    expect(screen.getByText('拆解失败：tasks 至少一条，请重新拆解后再派')).toBeTruthy()
    expect(screen.getByText('没有产生任何任务 · 请重新说一次')).toBeTruthy()
    expect(screen.queryByText(/^已派给/)).toBeNull()
  })

  it('keeps a pre-meta result as recorded text instead of parsing it', () => {
    render(<DispatchStatusRow {...props({
      block: result(undefined, '已派发 task-1 → 陈允（worker），截止 2026-10-25T18:00:00+08:00'),
    })} />)
    expect(screen.getByText('旧格式')).toBeTruthy()
    expect(screen.getByText('已派发 task-1 → 陈允（worker），截止 2026-10-25T18:00:00+08:00')).toBeTruthy()
    expect(screen.queryByText(/^已派给/)).toBeNull()
  })

  it('joins the ledger to show a delivered task waiting for review', async () => {
    ;(window as unknown as { cadre: unknown }).cadre = {
      listTasks: async () => ({
        rows: [
          { taskId: 'task-1', title: '复核清单', status: 'delivered' },
          { taskId: 'task-2', title: '补检定报告', status: 'in_progress' },
          { taskId: 'task-3', title: '结论汇总', status: 'dispatched' },
        ],
      }),
    }
    render(<DispatchStatusRow {...props({ block: result({ dispatched: DISPATCHED, failed: [] }) })} />)
    expect(await screen.findByText('陈允 · 复核清单 — 已交付，主管正在审')).toBeTruthy()
    expect(screen.getByText('陈允 · 补检定报告 — 正在执行')).toBeTruthy()
    expect(screen.getByText('陈允 · 复核清单')).toBeTruthy()
  })
})
