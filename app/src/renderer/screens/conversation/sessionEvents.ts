/**
 * 会话事件累积（契约 §5 / U-IPC-04）：
 * - 每会话单调 seq，`seq <= lastSeq` 丢弃；
 * - epoch 变化（会话重建）先清空该会话累积；
 * - delta 追加、complete 以全量文本收尾。
 * 仅处理白名单投影后的 SessionEvent，不接触 harness 原始事件。
 */
import type { SessionEvent } from '../../data/ipcContract.ts'

export type LocalMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  status: 'sent'
}

export type ConversationState = {
  messages: LocalMessage[]
  lastSeq: number
  epoch?: number
}

export const emptyConversationState: ConversationState = { messages: [], lastSeq: 0 }

const STREAM_ID = 'assistant-stream'

export function applySessionEvent(state: ConversationState, event: SessionEvent): ConversationState {
  const nextEpoch = event.epoch
  if (state.epoch !== undefined && nextEpoch !== state.epoch) {
    state = { messages: [], lastSeq: 0, epoch: nextEpoch }
  }
  if (event.seq <= state.lastSeq) return state

  const base: ConversationState = {
    ...state,
    lastSeq: event.seq,
    epoch: nextEpoch,
  }

  if (event.kind === 'message.delta' || event.kind === 'message.complete') {
    const existing = base.messages.find((message) => message.id === STREAM_ID)
    const text = event.kind === 'message.delta'
      ? `${existing?.text ?? ''}${event.text}`
      : event.text
    const streamMessage: LocalMessage = {
      id: STREAM_ID,
      role: 'assistant',
      text,
      at: new Date().toISOString(),
      status: 'sent',
    }
    return {
      ...base,
      messages: existing
        ? base.messages.map((message) => (message.id === STREAM_ID ? streamMessage : message))
        : [...base.messages, streamMessage],
    }
  }

  return base
}
