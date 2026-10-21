import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IsoTimestamp, MessageId, Sha256Hex } from '../../../src/collab/protocol/ids.ts'
import type { SessionEvent } from '../../../src/shared/ipc.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { ConversationScreen } from '../../../src/renderer/screens/conversation/ConversationScreen.tsx'
import { createFakeCadreApi, fakeFailure, fakeIds } from '../data/fake-api.ts'

function renderConversation(api: CadreApi) {
  return render(
    <CadreApiProvider api={api}>
      <LocaleProvider initialLocale="zh">
        <ConversationScreen />
      </LocaleProvider>
    </CadreApiProvider>,
  )
}

function receipt(body: string) {
  return {
    ok: true as const,
    bodyBytes: new TextEncoder().encode(body).length,
    preview: body,
    bodySha256: 'a'.repeat(64) as Sha256Hex,
    messageId: 'message-1' as MessageId,
    acceptedAt: '2026-10-21T10:00:00.000Z' as IsoTimestamp,
  }
}

describe('ConversationScreen 数据接入', () => {
  it('未连接时发送框禁用并提示', () => {
    renderConversation(createFakeCadreApi({ available: false }))

    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('composer-note').textContent).toContain('未连接到主进程')
  })

  it('写通道可用时发送并追加本地消息', async () => {
    const sendMessage = vi.fn(async ({ body }: { body: string }) => receipt(body))
    renderConversation(createFakeCadreApi({ sendMessage }))

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: '你好，主管' } })
    fireEvent.click(screen.getByTestId('composer-send'))

    expect(await screen.findByText('你好，主管')).toBeTruthy()
    expect(sendMessage).toHaveBeenCalledWith({ sessionId: expect.anything(), body: '你好，主管' })
    expect(input.value).toBe('')
  })

  it('发送遇 CROSS_PROJECT_DENIED 时清空消息并显示 denied', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(receipt('第一条'))
      .mockResolvedValueOnce(fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝'))
    renderConversation(createFakeCadreApi({ sendMessage }))

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: '第一条' } })
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(await screen.findByText('第一条')).toBeTruthy()

    fireEvent.change(input, { target: { value: '第二条' } })
    fireEvent.click(screen.getByTestId('composer-send'))

    expect(await screen.findByTestId('conversation-denied')).toBeTruthy()
    expect(screen.queryByText('第一条')).toBeNull()
  })
})

function subscriptionApi() {
  let listener: ((event: SessionEvent) => void) | undefined
  const stopListening = vi.fn()
  const subscribeSession = vi.fn(async () => ({
    ok: true as const,
    subscriptionId: 'sub-1',
  }))
  const onSessionEvent = vi.fn((callback: (event: SessionEvent) => void) => {
    listener = callback
    return stopListening
  })
  const api = createFakeCadreApi({ subscribeSession, onSessionEvent })
  return {
    api,
    subscribeSession,
    onSessionEvent,
    stopListening,
    emit: (event: SessionEvent) => act(() => listener?.(event)),
  }
}

describe('会话事件订阅（dc974a8）', () => {
  it('首次订阅无 lastSeq；重订阅携带本地最后 seq', async () => {
    const harness = subscriptionApi()
    renderConversation(harness.api)

    await waitFor(() => expect(harness.onSessionEvent).toHaveBeenCalled())
    expect(harness.subscribeSession.mock.calls[0]?.[0]).toEqual({ sessionId: fakeIds.sessionId })

    harness.emit({
      kind: 'message.delta', sessionId: fakeIds.sessionId, text: '已收到', seq: 4, epoch: 1,
    })
    expect(await screen.findByText('已收到')).toBeTruthy()

    fireEvent.click(screen.getByTestId('conversation-reconnect'))

    await waitFor(() => expect(harness.subscribeSession).toHaveBeenCalledTimes(2))
    expect(harness.subscribeSession.mock.calls[1]?.[0]).toEqual({
      sessionId: fakeIds.sessionId,
      lastSeq: 4,
    })
    expect(harness.stopListening).toHaveBeenCalled()
  })

  it('仅终态补发时 complete/error 收敛 UI，streaming 状态正确', async () => {
    const harness = subscriptionApi()
    renderConversation(harness.api)
    await waitFor(() => expect(harness.onSessionEvent).toHaveBeenCalled())

    harness.emit({
      kind: 'message.complete', sessionId: fakeIds.sessionId, text: '历史回答', seq: 9, epoch: 1,
    })
    expect(await screen.findByText('历史回答')).toBeTruthy()
    expect(screen.queryByTestId('conversation-streaming')).toBeNull()

    harness.emit({
      kind: 'message.delta', sessionId: fakeIds.sessionId, text: '新增', seq: 10, epoch: 1,
    })
    expect(screen.getByTestId('conversation-streaming')).toBeTruthy()

    harness.emit({
      kind: 'session.error',
      sessionId: fakeIds.sessionId,
      error: { code: 'ENGINE_FAILED', message: '引擎失败', retryable: true },
      seq: 11,
      epoch: 1,
    })
    await waitFor(() => expect(screen.getByTestId('conversation-error')).toBeTruthy())
    expect(screen.getByTestId('conversation-error').textContent).toContain('引擎失败')
    expect(screen.queryByTestId('conversation-streaming')).toBeNull()
  })
})
