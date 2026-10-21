import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageId, SessionId } from '../../../src/collab/protocol/ids.ts'
import type { TaskDetail } from '../../../src/collab/protocol/tool-outputs.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { LedgerScreen } from '../../../src/renderer/screens/ledger/LedgerScreen.tsx'
import { createFakeCadreApi, fakeFailure, fakeIds, fakeTask } from '../data/fake-api.ts'

function renderLedger(api: CadreApi) {
  return render(
    <CadreApiProvider api={api}>
      <LocaleProvider initialLocale="zh">
        <LedgerScreen />
      </LocaleProvider>
    </CadreApiProvider>,
  )
}

describe('LedgerScreen 数据接入', () => {
  it('渲染 TaskSummary 字段：标题、状态、员工、时间', async () => {
    const listTasks = vi.fn(async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [fakeTask()],
    }))
    renderLedger(createFakeCadreApi({ listTasks }))

    expect(await screen.findByText('实现台账列表')).toBeTruthy()
    const row = screen.getByTestId('task-row-task-1')
    expect(row.textContent).toContain('进行中')
    expect(row.textContent).toContain('前端员工')
  })

  it('empty≠error：EmptyList 显示 reason/hint 且无 alert', async () => {
    const listTasks = async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [],
      empty: true as const,
      reason: 'no_tasks' as const,
      hint: '前往会话流派发任务。',
    })
    const { container } = renderLedger(createFakeCadreApi({ listTasks }))

    // 标题与 reason 文案相同（no_tasks），断言空态区块存在即可。
    expect((await screen.findAllByText('还没有任务')).length).toBeGreaterThan(0)
    expect(screen.getByText('前往会话流派发任务。')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull()
  })

  it('CROSS_PROJECT_DENIED 显示 denied 并清空列表', async () => {
    const listTasks = async () => fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝')
    const { container } = renderLedger(createFakeCadreApi({ listTasks }))

    expect(await screen.findByText('当前项目不可用')).toBeTruthy()
    expect(screen.getByText('跨项目拒绝')).toBeTruthy()
    expect(container.querySelector('[data-testid^="task-row-"]')).toBeNull()
  })

  it('按 taskId 打开详情（只读）', async () => {
    const detail: TaskDetail = {
      ...fakeTask(),
      body: '实现台账列表与详情',
      transitions: [
        {
          from: null,
          to: 'dispatched',
          at: '2026-10-21T09:00:00.000Z' as TaskDetail['updatedAt'],
          actorSessionId: 'system',
        },
      ],
      report: {
        summary: '已完成',
        deliverables: ['src/renderer/screens/ledger/LedgerScreen.tsx'],
        bodyBytes: 12,
        preview: '已完成',
        messageId: 'message-1' as MessageId,
      },
      sourceSessionId: 'session-0' as SessionId,
      version: 1,
    }
    const listTasks = async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [fakeTask()],
    })
    const getTask = vi.fn(async () => ({ ok: true as const, ...detail }))
    renderLedger(createFakeCadreApi({ listTasks, getTask }))

    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    expect(await screen.findByText('实现台账列表与详情')).toBeTruthy()
    expect(getTask).toHaveBeenCalledWith({ taskId: fakeIds.taskId })
    expect(screen.getByText('已完成')).toBeTruthy()
  })

  it('状态筛选参数传到 listTasks', async () => {
    const listTasks = vi.fn(async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [fakeTask()],
    }))
    renderLedger(createFakeCadreApi({ listTasks }))
    await screen.findByText('实现台账列表')

    fireEvent.change(screen.getByTestId('ledger-filter'), { target: { value: 'failed' } })

    await waitFor(() => {
      expect(listTasks.mock.calls.some(([query]) => query?.status === 'failed')).toBe(true)
    })
  })
})
