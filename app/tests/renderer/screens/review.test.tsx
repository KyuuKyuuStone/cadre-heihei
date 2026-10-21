import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { IdentityProvider } from '../../../src/renderer/data/IdentityProvider.tsx'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { LedgerScreen } from '../../../src/renderer/screens/ledger/LedgerScreen.tsx'
import {
  createFakeCadreApi,
  fakeFailure,
  fakeIds,
  fakeTimestamp,
  fakeTask,
  fakeTaskDetail,
} from '../data/fake-api.ts'

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

function supervisorApi(overrides: Partial<CadreApi> = {}): CadreApi {
  return createFakeCadreApi({
    listTasks: async () => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      items: [fakeTask({ status: 'review' })],
    }),
    getTask: async () => ({ ok: true, ...fakeTaskDetail({ status: 'review' }) }),
    ...overrides,
  })
}

async function openReview() {
  fireEvent.click(await screen.findByTestId('task-row-task-1'))
  return screen.findByTestId('review-section')
}

describe('验收（仅 supervisor）', () => {
  it('rework 缺 reason 就地提示且不发送', async () => {
    const reviewTask = vi.fn()
    renderLedger(supervisorApi({ reviewTask }))
    await openReview()

    fireEvent.change(screen.getByTestId('review-action'), { target: { value: 'rework' } })
    fireEvent.click(screen.getByTestId('review-submit'))

    expect((await screen.findByTestId('review-reason-required')).textContent).toContain('原因')
    expect(reviewTask).not.toHaveBeenCalled()
  })

  it('成功后展示 TransitionReceipt 并刷新详情与台账', async () => {
    const reviewTask = vi.fn(async ({ reason }: { reason?: string }) => ({
      ok: true as const,
      taskId: fakeIds.taskId,
      from: 'review' as const,
      to: 'rework' as const,
      attempt: 1,
      updatedAt: fakeTimestamp,
      reason,
      ledgerUpdated: true as const,
    }))
    const getTask = vi.fn(async () => ({ ok: true as const, ...fakeTaskDetail({ status: 'review' }) }))
    const listTasks = vi.fn(async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [fakeTask({ status: 'review' })],
    }))
    renderLedger(supervisorApi({ reviewTask, getTask, listTasks }))
    await openReview()

    fireEvent.change(screen.getByTestId('review-action'), { target: { value: 'rework' } })
    fireEvent.change(screen.getByTestId('review-reason'), { target: { value: '补充测试' } })
    fireEvent.click(screen.getByTestId('review-submit'))

    const receipt = await screen.findByTestId('review-receipt')
    expect(receipt.textContent).toContain('返工')
    expect(reviewTask).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rework',
      reason: '补充测试',
    }))
    await waitFor(() => {
      expect(getTask.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('INVALID_TRANSITION 按错误映射就地展示', async () => {
    const reviewTask = vi.fn(async () => fakeFailure('INVALID_TRANSITION', '当前状态不允许该动作'))
    renderLedger(supervisorApi({ reviewTask }))
    await openReview()

    fireEvent.change(screen.getByTestId('review-action'), { target: { value: 'verify' } })
    fireEvent.click(screen.getByTestId('review-submit'))

    const error = await screen.findByTestId('review-error')
    expect(error.textContent).toContain('当前状态不允许该动作')
    expect(error.textContent).toContain('INVALID_TRANSITION')
  })

  it('worker 不显示验收入口', async () => {
    const whoami = vi.fn(async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      projectId: fakeIds.projectId,
      sessionId: 'session-worker' as typeof fakeIds.sessionId,
      role: 'worker' as const,
      projectName: 'demo',
    }))
    renderLedger(supervisorApi({ whoami }))

    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    await screen.findByTestId('task-detail')
    await waitFor(() => expect(whoami).toHaveBeenCalled())
    expect(screen.queryByTestId('review-section')).toBeNull()
  })
})
