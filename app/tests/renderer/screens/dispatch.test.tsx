import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageId, TaskId } from '../../../src/collab/protocol/ids.ts'
import type { RosterResponse } from '../../../src/collab/protocol/roster.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { IdentityProvider } from '../../../src/renderer/data/IdentityProvider.tsx'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { LedgerScreen } from '../../../src/renderer/screens/ledger/LedgerScreen.tsx'
import { createFakeCadreApi, fakeFailure, fakeIds, fakeSha, fakeTimestamp } from '../data/fake-api.ts'

function rosterWithWorker(): RosterResponse {
  return {
    ok: true,
    apiVersion: 'cadre-heihei/1',
    projects: [],
    members: [
      {
        sessionId: fakeIds.sessionId,
        displayName: '前端员工',
        role: 'worker',
        state: 'available',
        projectId: fakeIds.projectId,
        dispatchable: true,
      },
      {
        sessionId: 'session-offline' as typeof fakeIds.sessionId,
        displayName: '离线员工',
        role: 'worker',
        state: 'offline',
        projectId: fakeIds.projectId,
        dispatchable: false,
      },
    ],
    scope: {
      scope: { kind: 'project', projectId: fakeIds.projectId },
      globalCount: 2,
      dispatchableCount: 1,
      projectMatched: true,
    },
  }
}

function dispatchReceipt(body: string) {
  return {
    ok: true as const,
    apiVersion: 'cadre-heihei/1' as const,
    taskId: 'task-new' as TaskId,
    projectId: fakeIds.projectId,
    messageId: 'message-dispatch' as MessageId,
    channel: 'mailbox' as const,
    taskStatus: 'dispatched' as const,
    deliveredAt: fakeTimestamp,
    bodyBytes: body.length,
    preview: body,
    bodySha256: fakeSha,
    serverVersion: 'test',
    ledgerUpdated: true as const,
  }
}

function renderLedger(api: CadreApi) {
  return render(
    <CadreApiProvider api={api}>
      <IdentityProvider>
        <LocaleProvider initialLocale="zh">
          <LedgerScreen />
        </LocaleProvider>
      </IdentityProvider>
    </CadreApiProvider>,
  )
}

async function openDispatchForm() {
  fireEvent.click(await screen.findByTestId('dispatch-open'))
  await screen.findByText('前端员工')
  fireEvent.change(screen.getByTestId('dispatch-target'), { target: { value: fakeIds.sessionId } })
  fireEvent.change(screen.getByTestId('dispatch-title'), { target: { value: '新任务' } })
}

describe('派活（仅 supervisor）', () => {
  it('成功派活展示回执并刷新台账', async () => {
    const dispatchTask = vi.fn(async ({ body }: { body: string }) => dispatchReceipt(body))
    const listTasks = vi.fn(async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [] }))
    renderLedger(createFakeCadreApi({ dispatchTask, listTasks, listRoster: async () => rosterWithWorker() }))

    await openDispatchForm()
    fireEvent.change(screen.getByTestId('dispatch-body'), { target: { value: '派活正文' } })
    fireEvent.click(screen.getByTestId('dispatch-submit'))

    const receipt = await screen.findByTestId('dispatch-receipt')
    expect(receipt.textContent).toContain('task-new')
    expect(receipt.textContent).toContain('4')
    expect(receipt.textContent).toContain('派活正文')
    await waitFor(() => expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({ toSessionId: fakeIds.sessionId, title: '新任务' })
  })

  it('空正文 EMPTY_BODY 就地显示，不刷新台账', async () => {
    const dispatchTask = vi.fn(async () => fakeFailure('EMPTY_BODY', '正文不能为空', { field: 'body' }))
    const listTasks = vi.fn(async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [] }))
    renderLedger(createFakeCadreApi({ dispatchTask, listTasks, listRoster: async () => rosterWithWorker() }))

    await openDispatchForm()
    fireEvent.click(screen.getByTestId('dispatch-submit'))

    expect((await screen.findByTestId('dispatch-error')).textContent).toContain('正文不能为空')
    expect(listTasks).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('dispatch-receipt')).toBeNull()
  })

  it('客户端命令 CLIENT_COMMAND_REJECTED 就地显示', async () => {
    const dispatchTask = vi.fn(async () =>
      fakeFailure('CLIENT_COMMAND_REJECTED', '客户端命令不允许', { command: '/compact' }))
    renderLedger(createFakeCadreApi({ dispatchTask, listRoster: async () => rosterWithWorker() }))

    await openDispatchForm()
    fireEvent.change(screen.getByTestId('dispatch-body'), { target: { value: '/compact' } })
    fireEvent.click(screen.getByTestId('dispatch-submit'))

    expect((await screen.findByTestId('dispatch-error')).textContent).toContain('客户端命令不允许')
  })

  it('worker 不显示派活入口', async () => {
    const whoami = vi.fn(async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      projectId: fakeIds.projectId,
      sessionId: fakeIds.sessionId,
      role: 'worker' as const,
      projectName: 'demo',
    }))
    renderLedger(createFakeCadreApi({ whoami }))

    await waitFor(() => expect(whoami).toHaveBeenCalled())
    await screen.findByTestId('ledger-filter')
    expect(screen.queryByTestId('dispatch-open')).toBeNull()
  })

  it('pending 时重复点击不重复调用（同一次提交）', async () => {
    let resolveDispatch!: (value: ReturnType<typeof dispatchReceipt>) => void
    const dispatchTask = vi.fn(() => new Promise<ReturnType<typeof dispatchReceipt>>((resolve) => {
      resolveDispatch = resolve
    }))
    renderLedger(createFakeCadreApi({ dispatchTask, listRoster: async () => rosterWithWorker() }))

    await openDispatchForm()
    fireEvent.change(screen.getByTestId('dispatch-body'), { target: { value: '正文' } })
    const submit = screen.getByTestId('dispatch-submit')
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(dispatchTask).toHaveBeenCalledTimes(1)
    resolveDispatch(dispatchReceipt('正文'))
    expect(await screen.findByTestId('dispatch-receipt')).toBeTruthy()
  })

  it('失败后重试复用同一幂等键', async () => {
    const dispatchTask = vi.fn()
      .mockResolvedValueOnce(fakeFailure('INTERNAL_ERROR', '临时失败'))
      .mockResolvedValueOnce(dispatchReceipt('正文'))
    renderLedger(createFakeCadreApi({ dispatchTask, listRoster: async () => rosterWithWorker() }))

    await openDispatchForm()
    fireEvent.change(screen.getByTestId('dispatch-body'), { target: { value: '正文' } })
    fireEvent.click(screen.getByTestId('dispatch-submit'))
    await screen.findByTestId('dispatch-error')

    fireEvent.click(screen.getByTestId('dispatch-submit'))
    await screen.findByTestId('dispatch-receipt')

    const firstKey = dispatchTask.mock.calls[0]?.[0]?.idempotencyKey
    const secondKey = dispatchTask.mock.calls[1]?.[0]?.idempotencyKey
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)
  })
})
