import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../../src/collab/protocol/ids.ts'
import {
  applySessionEvent,
  emptyConversationState,
} from '../../../src/renderer/screens/conversation/sessionEvents.ts'

const sessionId = 'session-1' as SessionId
const epoch = 1

describe('SessionEvent 累积（契约 §5 / U-IPC-04 / dc974a8）', () => {
  it('delta 追加到同一条 assistant 消息并进入 streaming', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '你', seq: 1, epoch,
    })
    const second = applySessionEvent(first, {
      kind: 'message.delta', sessionId, text: '好', seq: 2, epoch,
    })
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]?.text).toBe('你好')
    expect(second.lastSeq).toBe(2)
    expect(second.streaming).toBe(true)
  })

  it('complete 用全量文本收尾并收敛 streaming', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '半句', seq: 1, epoch,
    })
    const done = applySessionEvent(first, {
      kind: 'message.complete', sessionId, text: '完整回答', seq: 2, epoch,
    })
    expect(done.messages[0]?.text).toBe('完整回答')
    expect(done.streaming).toBe(false)
  })

  it('跳号只推进 lastSeq，不清空累积', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: 'a', seq: 1, epoch,
    })
    // delta 合并会造成 seq 跳号：5 直接落在 1 之后。
    const jumped = applySessionEvent(first, {
      kind: 'message.delta', sessionId, text: 'b', seq: 5, epoch,
    })
    expect(jumped.lastSeq).toBe(5)
    expect(jumped.messages[0]?.text).toBe('ab')

    const stale = applySessionEvent(jumped, {
      kind: 'message.delta', sessionId, text: 'X', seq: 4, epoch,
    })
    expect(stale).toBe(jumped)
  })

  it('仅终态补发（无 lastSeq）时 complete 收敛出消息', () => {
    // 首次订阅未给 lastSeq：后端只补终态。
    const state = applySessionEvent(emptyConversationState, {
      kind: 'message.complete', sessionId, text: '历史回答', seq: 10, epoch,
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text).toBe('历史回答')
    expect(state.streaming).toBe(false)
  })

  it('重复 complete 幂等，不重复追加消息', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.complete', sessionId, text: '最终回答', seq: 10, epoch,
    })
    const repeatedSameSeq = applySessionEvent(first, {
      kind: 'message.complete', sessionId, text: '最终回答', seq: 10, epoch,
    })
    expect(repeatedSameSeq).toBe(first)

    const repeatedNewerSeq = applySessionEvent(first, {
      kind: 'message.complete', sessionId, text: '最终回答', seq: 11, epoch,
    })
    expect(repeatedNewerSeq.messages).toHaveLength(1)
    expect(repeatedNewerSeq.messages[0]?.text).toBe('最终回答')
  })

  it('仅终态 error 收敛为 UI 错误且结束 streaming', () => {
    const state = applySessionEvent(emptyConversationState, {
      kind: 'session.error',
      sessionId,
      error: { code: 'ENGINE_FAILED', message: '引擎失败', retryable: true },
      seq: 7,
      epoch,
    })
    expect(state.streaming).toBe(false)
    expect(state.error).toEqual({ code: 'ENGINE_FAILED', message: '引擎失败', retryable: true })
    expect(state.messages).toHaveLength(0)
  })

  it('closed 结束 streaming 并保留已收消息', () => {
    const delta = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '部分输出', seq: 1, epoch,
    })
    const closed = applySessionEvent(delta, {
      kind: 'session.closed', sessionId, reason: 'crashed', seq: 2, epoch,
    })
    expect(closed.streaming).toBe(false)
    expect(closed.messages[0]?.text).toBe('部分输出')
  })

  it('epoch 变化清空累积（含 error/streaming）后再接收补发', () => {
    const errored = applySessionEvent(emptyConversationState, {
      kind: 'session.error',
      sessionId,
      error: { code: 'ENGINE_FAILED', message: '崩溃', retryable: false },
      seq: 9,
      epoch: 1,
    })
    const rebuilt = applySessionEvent(errored, {
      kind: 'message.delta', sessionId, text: '新会话', seq: 1, epoch: 2,
    })
    expect(rebuilt.epoch).toBe(2)
    expect(rebuilt.lastSeq).toBe(1)
    expect(rebuilt.messages).toHaveLength(1)
    expect(rebuilt.messages[0]?.text).toBe('新会话')
    expect(rebuilt.error).toBeUndefined()
  })

  it('非消息事件只推进 seq', () => {
    const state = applySessionEvent(emptyConversationState, {
      kind: 'tool.call', sessionId, toolName: 'read', callId: 'c1', summary: '读取', seq: 3, epoch,
    })
    expect(state.lastSeq).toBe(3)
    expect(state.messages).toHaveLength(0)
  })
})
