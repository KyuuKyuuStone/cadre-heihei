/**
 * 会话事件累积（契约 §5 / U-IPC-04 / dc974a8）：
 * - 每会话单调 seq，`seq <= lastSeq` 丢弃；跳号只表示 delta 被合并，不清空；
 * - epoch 变化（会话重建）先清空该会话累积（含 lastSeq/streaming/error），再接收补发；
 * - delta 追加、complete 以全量文本收尾（同一 stream id，不重复追加）；
 * - complete/error/closed 收敛 streaming；error 记录结构化错误供 UI 展示。
 * 仅处理白名单投影后的 SessionEvent，不接触 harness 原始事件。
 */
import type { SessionEvent } from '../../data/ipcContract.ts'

export type LocalMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: string
  status: 'sent'
  /** 工具输出落盘文件（A-F2 的「打开文件」入口使用）。 */
  outputFile?: string
}

export type ConversationError = {
  code: string
  message: string
  retryable: boolean
}

export type ConversationState = {
  messages: LocalMessage[]
  lastSeq: number
  epoch?: number
  streaming: boolean
  error?: ConversationError
}

export const emptyConversationState: ConversationState = { messages: [], lastSeq: 0, streaming: false }

const STREAM_ID = 'assistant-stream'

function upsertStream(state: ConversationState, text: string, streaming: boolean): ConversationState {
  const existing = state.messages.find((message) => message.id === STREAM_ID)
  const streamMessage: LocalMessage = {
    id: STREAM_ID,
    role: 'assistant',
    text,
    at: new Date().toISOString(),
    status: 'sent',
  }
  return {
    ...state,
    streaming,
    messages: existing
      ? state.messages.map((message) => (message.id === STREAM_ID ? streamMessage : message))
      : [...state.messages, streamMessage],
  }
}

export function applySessionEvent(state: ConversationState, event: SessionEvent): ConversationState {
  const nextEpoch = event.epoch
  if (state.epoch !== undefined && nextEpoch !== state.epoch) {
    // 重建：旧实例的累积没有意义，清空后同一事件继续落入新 epoch。
    state = { messages: [], lastSeq: 0, epoch: nextEpoch, streaming: false }
  }
  // 跳号不清空：delta 合并会造成 seq 跳号，只推进 lastSeq。
  if (event.seq <= state.lastSeq) return state

  const base: ConversationState = { ...state, lastSeq: event.seq, epoch: nextEpoch }

  switch (event.kind) {
    case 'message.delta': {
      const existing = base.messages.find((message) => message.id === STREAM_ID)
      return { ...upsertStream(base, `${existing?.text ?? ''}${event.text}`, true), error: undefined }
    }
    case 'message.complete':
      return { ...upsertStream(base, event.text, false), error: undefined }
    case 'tool.result': {
      const message: LocalMessage = {
        id: `tool-${event.callId}`,
        role: 'tool',
        text: event.summary,
        at: new Date().toISOString(),
        status: 'sent',
        ...(event.outputFile ? { outputFile: event.outputFile } : {}),
      }
      const exists = base.messages.some((item) => item.id === message.id)
      return {
        ...base,
        messages: exists
          ? base.messages.map((item) => (item.id === message.id ? message : item))
          : [...base.messages, message],
      }
    }
    case 'session.error':
      return { ...base, streaming: false, error: event.error }
    case 'session.closed':
      return { ...base, streaming: false }
    default:
      return base
  }
}
