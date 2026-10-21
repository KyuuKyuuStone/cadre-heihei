import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../../src/collab/protocol/ids.ts'
import {
  applySessionEvent,
  emptyConversationState,
} from '../../../src/renderer/screens/conversation/sessionEvents.ts'

const sessionId = 'session-1' as SessionId
const epoch = 1

describe('SessionEvent 累积（契约 §5 / U-IPC-04）', () => {
  it('delta 追加到同一条 assistant 消息', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '你', seq: 1, epoch,
    })
    const second = applySessionEvent(first, {
      kind: 'message.delta', sessionId, text: '好', seq: 2, epoch,
    })
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]?.text).toBe('你好')
    expect(second.lastSeq).toBe(2)
  })

  it('complete 用全量文本收尾', () => {
    const first = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '半句', seq: 1, epoch,
    })
    const done = applySessionEvent(first, {
      kind: 'message.complete', sessionId, text: '完整回答', seq: 2, epoch,
    })
    expect(done.messages[0]?.text).toBe('完整回答')
  })

  it('seq 回退被丢弃', () => {
    const state = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: 'abc', seq: 5, epoch,
    })
    const stale = applySessionEvent(state, {
      kind: 'message.delta', sessionId, text: 'X', seq: 4, epoch,
    })
    expect(stale).toBe(state)
  })

  it('epoch 变化清空累积并重置 seq', () => {
    const state = applySessionEvent(emptyConversationState, {
      kind: 'message.delta', sessionId, text: '旧会话', seq: 9, epoch: 1,
    })
    const rebuilt = applySessionEvent(state, {
      kind: 'message.delta', sessionId, text: '新会话', seq: 1, epoch: 2,
    })
    expect(rebuilt.epoch).toBe(2)
    expect(rebuilt.lastSeq).toBe(1)
    expect(rebuilt.messages).toHaveLength(1)
    expect(rebuilt.messages[0]?.text).toBe('新会话')
  })

  it('非消息事件只推进 seq', () => {
    const state = applySessionEvent(emptyConversationState, {
      kind: 'tool.call', sessionId, toolName: 'read', callId: 'c1', summary: '读取', seq: 3, epoch,
    })
    expect(state.lastSeq).toBe(3)
    expect(state.messages).toHaveLength(0)
  })
})
