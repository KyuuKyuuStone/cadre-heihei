import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageId } from '../../../src/collab/protocol/ids.ts'
import type { ReportReceipt } from '../../../src/collab/protocol/report.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { IdentityProvider } from '../../../src/renderer/data/IdentityProvider.tsx'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { LedgerScreen } from '../../../src/renderer/screens/ledger/LedgerScreen.tsx'
import {
  createFakeCadreApi,
  fakeIds,
  fakeSha,
  fakeTask,
  fakeTaskDetail,
  fakeTimestamp,
} from '../data/fake-api.ts'

function reportReceipt(body: string, overrides: Partial<ReportReceipt> = {}): ReportReceipt {
  return {
    ok: true,
    apiVersion: 'cadre-heihei/1',
    messageId: 'message-report' as MessageId,
    taskId: fakeIds.taskId,
    projectId: fakeIds.projectId,
    channel: 'mailbox',
    taskStatusBefore: 'in_progress',
    taskStatusAfter: 'delivered',
    deliveredAt: fakeTimestamp,
    bodyBytes: body.length,
    preview: body,
    bodySha256: fakeSha,
    serverVersion: 'test',
    ledgerUpdated: true,
    ...overrides,
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

function workerApi(overrides: Partial<CadreApi> = {}): CadreApi {
  return createFakeCadreApi({
    whoami: async () => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      projectId: fakeIds.projectId,
      sessionId: fakeIds.sessionId,
      role: 'worker',
      projectName: 'demo',
    }),
    listTasks: async () => ({ ok: true, apiVersion: 'cadre-heihei/1', items: [fakeTask()] }),
    getTask: async () => ({ ok: true, ...fakeTaskDetail() }),
    ...overrides,
  })
}

async function openReportForm() {
  fireEvent.click(await screen.findByTestId('task-row-task-1'))
  fireEvent.click(await screen.findByTestId('report-open'))
}

describe('汇报（仅 assignee）', () => {
  it('提交成功展示状态变化与实收字段', async () => {
    const reportTask = vi.fn(async ({ body }: { body: string }) => reportReceipt(body))
    renderLedger(workerApi({ reportTask }))

    await openReportForm()
    fireEvent.change(screen.getByTestId('report-body'), { target: { value: '已完成' } })
    fireEvent.change(screen.getByTestId('report-deliverables'), {
      target: { value: 'app/src/a.ts\n\napp/src/b.ts' },
    })
    fireEvent.click(screen.getByTestId('report-submit'))

    const receipt = await screen.findByTestId('report-receipt')
    expect(receipt.textContent).toContain('进行中')
    expect(receipt.textContent).toContain('已交付')
    expect(receipt.textContent).toContain('3')
    expect(receipt.textContent).toContain('已完成')
    expect(reportTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: fakeIds.taskId,
      deliverables: ['app/src/a.ts', 'app/src/b.ts'],
    }))
  })

  it('ledgerUpdated=false 显示 ledgerError，不伪报成功', async () => {
    const reportTask = vi.fn(async () =>
      reportReceipt('已完成', { ledgerUpdated: false, ledgerError: 'ledger locked' }))
    renderLedger(workerApi({ reportTask }))

    await openReportForm()
    fireEvent.change(screen.getByTestId('report-body'), { target: { value: '已完成' } })
    fireEvent.click(screen.getByTestId('report-submit'))

    const error = await screen.findByTestId('report-ledger-error')
    expect(error.textContent).toContain('台账未推进')
    expect(error.textContent).toContain('ledger locked')
  })

  it('非 assignee 不显示汇报入口', async () => {
    const api = workerApi({
      whoami: async () => ({
        ok: true,
        apiVersion: 'cadre-heihei/1',
        projectId: fakeIds.projectId,
        sessionId: 'session-other' as typeof fakeIds.sessionId,
        role: 'worker',
        projectName: 'demo',
      }),
    })
    renderLedger(api)

    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    await screen.findByTestId('task-detail')
    expect(screen.queryByTestId('report-open')).toBeNull()
  })
})
