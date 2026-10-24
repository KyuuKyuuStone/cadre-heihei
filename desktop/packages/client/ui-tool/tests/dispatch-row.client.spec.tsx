// @vitest-environment jsdom
/** W2 dispatch status row: running, success, partial, failure, and ledger join. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DispatchStatusRow } from '../src/client/tool/toolviews/dispatch-row.tsx'

type Props = Parameters<typeof DispatchStatusRow>[0]

function result(text: string, isError = false): ToolResultNode {
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
    isError,
    subCalls: [],
  }
}

function props(overrides: Record<string, unknown>): Props {
  return {
    phase: 'result',
    block: result(''),
    sessionId: 's1',
    retry: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as Props
}

const lines = [
  '已派发 task-1 → 陈允（后端），截止 2026-10-24T18:00:00+08:00',
  '已派发 task-2 → 陈允（后端），截止 2026-10-24T18:00:00+08:00',
  '已派发 task-3 → 沈青（测试），截止 2026-10-24T18:00:00+08:00',
]

beforeEach(() => {
  delete (window as unknown as { cadre?: unknown }).cadre
})
afterEach(cleanup)

describe('DispatchStatusRow', () => {
  it('shows 拆解中 while the call has no result', () => {
    render(<DispatchStatusRow {...props({ phase: 'start', block: { phase: 'start', name: 'dispatch_task', callId: 'c1', args: PartialArguments.fromText('{}'), argsRaw: '{}', turn: 1, step: 1, time: 1, subCalls: [] } })} />)
    expect(screen.getByText('拆解中…')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  it('groups dispatched tasks by assignee with the recorded deadline', () => {
    render(<DispatchStatusRow {...props({ block: result(lines.join('\n')) })} />)
    expect(screen.getByText('已派给 陈允（2 条） · 沈青（1 条）')).toBeTruthy()
    expect(screen.getByText(/^共 3 条任务 · 截止 /)).toBeTruthy()
    expect(screen.getByText('陈允 · task-1')).toBeTruthy()
    expect(screen.getByText('沈青 · task-3')).toBeTruthy()
  })

  it('never presents a partial dispatch as all dispatched and offers retry for a hard failure', async () => {
    const retry = vi.fn(async () => ({ ok: true }))
    render(<DispatchStatusRow {...props({
      block: result([...lines.slice(0, 2), '未派出「沈青」：台账写入失败：database is locked'].join('\n')),
      retry,
    })} />)
    expect(screen.getByText('部分成功 · 成功 2 条 · 失败 1 条')).toBeTruthy()
    expect(screen.queryByText(/^已派给/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText('已请主管重试')).toBeTruthy() })
    expect(retry).toHaveBeenCalledWith('沈青', '台账写入失败：database is locked')
  })

  it('marks an offline target as 待派 and asks for a replacement instead of retrying', () => {
    render(<DispatchStatusRow {...props({
      block: result([...lines.slice(0, 2), '未派出「沈青」：待派：员工 runtime 已停'].join('\n')),
    })} />)
    expect(screen.getByText('待派')).toBeTruthy()
    expect(screen.getByText('请换人')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('shows a decomposition failure with its reason and no task rows', () => {
    render(<DispatchStatusRow {...props({ block: result('拆解失败：tasks 至少一条，请重新拆解后再派', true) })} />)
    expect(screen.getByText('拆解失败')).toBeTruthy()
    expect(screen.getByText('拆解失败：tasks 至少一条，请重新拆解后再派')).toBeTruthy()
    expect(screen.getByText('没有产生任何任务 · 请重新说一次')).toBeTruthy()
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
    render(<DispatchStatusRow {...props({ block: result(lines.join('\n')) })} />)
    expect(await screen.findByText('陈允 · 复核清单 — 已交付，主管正在审')).toBeTruthy()
    expect(screen.getByText('陈允 · 补检定报告 — 正在执行')).toBeTruthy()
    expect(screen.getByText('陈允 · 复核清单')).toBeTruthy()
  })
})
