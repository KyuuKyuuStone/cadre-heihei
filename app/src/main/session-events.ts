/**
 * 会话事件泵（frontend/02 §5）：EngineEvent → SessionEvent 白名单投影。
 *
 * - 不传 raw / harness 原始 payload；
 * - `push()` 入口即分配 seq（无论是否有订阅者），因此无订阅期事件也会占号并可补发；
 * - message.delta 默认 16ms 合并；complete/error/closed 立即 flush；
 *   合并后的 delta 使用本批最后一条的 seq（renderer 看到跳号 = delta 被合并）；
 * - 每会话环形缓冲最近 256 条投影；终态事件（complete/error/closed）额外保留，
 *   不被普通淘汰；
 * - subscribe 支持 lastSeq：补发 seq > lastSeq 的缓冲事件；未提供时只补发终态事件；
 * - 每会话单调 seq；重建（bumpEpoch）后 epoch+1、seq 从 0 重新计数并清空缓冲；
 * - 订阅按 windowId+sessionId 去重；窗口销毁清理；
 * - 输出通道固定 `session:event`，renderer 输入不能指定。
 *
 * 本模块不 import electron：M4 只需把 sink 接到 webContents.send。
 */
import { randomUUID } from 'node:crypto'
import type { EngineEvent } from '../ports/engine.ts'
import type { SessionEvent } from '../shared/ipc.ts'
import { IPC_CHANNELS } from '../shared/ipc.ts'
import type { SessionId } from '../collab/protocol/index.ts'

export const SESSION_EVENT_CHANNEL = IPC_CHANNELS.sessionEvent
export type SessionEventChannel = typeof SESSION_EVENT_CHANNEL
export const DEFAULT_EVENT_BUFFER_LIMIT = 256

export type SessionEventSink = (
  windowId: string,
  channel: SessionEventChannel,
  event: SessionEvent,
) => void

export interface SessionEventPumpOptions {
  readonly sink: SessionEventSink
  /** delta 合并窗口（U-IPC-05：16–32ms，默认 16）。 */
  readonly deltaThrottleMs?: number
  /** 每会话环形缓冲上限（默认 256；终态事件不受此上限淘汰）。 */
  readonly bufferLimit?: number
}

interface Subscription {
  readonly id: string
  readonly windowId: string
  readonly sessionId: SessionId
}

interface SessionState {
  epoch: number
  seq: number
}

interface PendingDelta {
  text: string
  lastSeq: number
  epoch: number
  timer?: NodeJS.Timeout
}

interface BufferedEvent {
  readonly event: SessionEvent
  readonly terminal: boolean
}

export interface SubscribeResult {
  readonly subscriptionId: string
  readonly created: boolean
}

const TERMINAL_KINDS = new Set<SessionEvent['kind']>([
  'message.complete',
  'session.error',
  'session.closed',
])

function stateKey(sessionId: SessionId): string {
  return String(sessionId)
}

function subscriptionKey(windowId: string, sessionId: SessionId): string {
  return `${windowId}\u0000${String(sessionId)}`
}

export class SessionEventPump {
  private readonly sink: SessionEventSink
  private readonly deltaThrottleMs: number
  private readonly bufferLimit: number
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byWindowSession = new Map<string, string>()
  private readonly bySession = new Map<string, Set<string>>()
  private readonly states = new Map<string, SessionState>()
  private readonly pending = new Map<string, PendingDelta>()
  private readonly buffers = new Map<string, BufferedEvent[]>()

  constructor(options: SessionEventPumpOptions) {
    this.sink = options.sink
    this.deltaThrottleMs = options.deltaThrottleMs ?? 16
    this.bufferLimit = options.bufferLimit ?? DEFAULT_EVENT_BUFFER_LIMIT
  }

  /**
   * 订阅并在返回前补发缓冲事件：
   * - 给了 lastSeq：补发 seq > lastSeq 的缓冲事件；
   * - 未给：只补发终态事件（保证 reload 后 UI 收敛）。
   */
  subscribe(windowId: string, sessionId: SessionId, lastSeq?: number): SubscribeResult {
    const key = subscriptionKey(windowId, sessionId)
    let subscriptionId = this.byWindowSession.get(key)
    let created = false
    if (subscriptionId === undefined || !this.subscriptions.has(subscriptionId)) {
      const subscription: Subscription = { id: `sub-${randomUUID()}`, windowId, sessionId }
      this.subscriptions.set(subscription.id, subscription)
      this.byWindowSession.set(key, subscription.id)
      const sessionKey = stateKey(sessionId)
      const set = this.bySession.get(sessionKey) ?? new Set<string>()
      set.add(subscription.id)
      this.bySession.set(sessionKey, set)
      subscriptionId = subscription.id
      created = true
    }
    this.replay(this.subscriptions.get(subscriptionId)!, lastSeq)
    return { subscriptionId, created }
  }

  /** 只允许订阅窗口自己的 subscription；未知 id 幂等返回 false。 */
  unsubscribe(windowId: string, subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined || subscription.windowId !== windowId) return false
    this.removeSubscription(subscription)
    return true
  }

  /** 窗口销毁：移除该窗口全部订阅与待发 delta（缓冲保留供重订补发）。 */
  dropWindow(windowId: string): number {
    let removed = 0
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.windowId !== windowId) continue
      this.removeSubscription(subscription)
      removed += 1
    }
    return removed
  }

  /** 会话重建：epoch+1、seq 归零、清空该会话缓冲（避免跨代次混淆）。 */
  bumpEpoch(sessionId: SessionId): number {
    const key = stateKey(sessionId)
    const current = this.states.get(key)?.epoch ?? 1
    this.clearPending(key)
    this.buffers.delete(key)
    this.states.set(key, { epoch: current + 1, seq: 0 })
    return current + 1
  }

  /** 入口即占 seq；无订阅者也不丢，写入缓冲供后续补发。 */
  push(event: EngineEvent): void {
    const sessionKey = stateKey(event.sessionId)
    const state = this.states.get(sessionKey) ?? { epoch: 1, seq: 0 }
    state.seq += 1
    this.states.set(sessionKey, state)
    const seq = state.seq
    const epoch = state.epoch

    if (event.kind === 'message.delta') {
      // 只进 pending；合并后（flush）才作为一条投影入缓冲，避免重放时重复拼接。
      this.appendDelta(sessionKey, event.text, seq, epoch)
      return
    }

    // 非 delta：先冲掉积压 delta（用批内最后 seq），再立即发本事件。
    this.flushSessionByKey(sessionKey)
    const projected = projectEngineEvent(event, seq, epoch)
    this.buffer(sessionKey, projected, TERMINAL_KINDS.has(event.kind))
    this.deliverToSubscribers(sessionKey, projected)
  }

  /** 立即冲刷全部未发 delta（测试与关停用）。 */
  flush(): void {
    for (const key of [...this.pending.keys()]) {
      this.flushSessionByKey(key)
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
    }
    this.pending.clear()
    this.subscriptions.clear()
    this.byWindowSession.clear()
    this.bySession.clear()
    this.buffers.clear()
  }

  private appendDelta(sessionKey: string, text: string, seq: number, epoch: number): void {
    const pending = this.pending.get(sessionKey) ?? { text: '', lastSeq: seq, epoch }
    pending.text += text
    pending.lastSeq = seq
    pending.epoch = epoch
    if (pending.timer === undefined) {
      pending.timer = setTimeout(() => {
        pending.timer = undefined
        this.flushSessionByKey(sessionKey)
      }, this.deltaThrottleMs)
      pending.timer.unref?.()
    }
    this.pending.set(sessionKey, pending)
  }

  private flushSessionByKey(sessionKey: string): void {
    const pending = this.pending.get(sessionKey)
    if (pending === undefined) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(sessionKey)
    if (pending.text === '') return
    const merged: SessionEvent = {
      kind: 'message.delta',
      sessionId: sessionKey as SessionId,
      text: pending.text,
      // 合并事件沿用批内最后一条的 seq；跳号表示 delta 被合并。
      seq: pending.lastSeq,
      epoch: pending.epoch,
    }
    this.buffer(sessionKey, merged, false)
    this.deliverToSubscribers(sessionKey, merged)
  }

  private buffer(sessionKey: string, event: SessionEvent, terminal: boolean): void {
    const buffer = this.buffers.get(sessionKey) ?? []
    buffer.push({ event, terminal })
    while (buffer.length > this.bufferLimit) {
      const index = buffer.findIndex((entry) => !entry.terminal)
      if (index < 0) break
      buffer.splice(index, 1)
    }
    this.buffers.set(sessionKey, buffer)
  }

  private replay(subscription: Subscription, lastSeq?: number): void {
    const buffer = this.buffers.get(stateKey(subscription.sessionId))
    if (buffer === undefined) return
    for (const entry of buffer) {
      const shouldSend =
        lastSeq === undefined ? entry.terminal : entry.event.seq > lastSeq
      if (!shouldSend) continue
      this.sink(subscription.windowId, SESSION_EVENT_CHANNEL, entry.event)
    }
  }

  private deliverToSubscribers(sessionKey: string, event: SessionEvent): void {
    for (const subscriptionId of [...this.subscribersFor(sessionKey)]) {
      const subscription = this.subscriptions.get(subscriptionId)
      if (subscription === undefined) continue
      this.sink(subscription.windowId, SESSION_EVENT_CHANNEL, event)
    }
  }

  private subscribersFor(sessionKey: string): string[] {
    return [...(this.bySession.get(sessionKey) ?? [])]
  }

  private removeSubscription(subscription: Subscription): void {
    this.subscriptions.delete(subscription.id)
    const key = subscriptionKey(subscription.windowId, subscription.sessionId)
    if (this.byWindowSession.get(key) === subscription.id) this.byWindowSession.delete(key)
    const sessionKey = stateKey(subscription.sessionId)
    const set = this.bySession.get(sessionKey)
    if (set !== undefined) {
      set.delete(subscription.id)
      if (set.size === 0) {
        this.bySession.delete(sessionKey)
        // 待发 delta 已逐条写入缓冲，清掉 timer 不会丢数据。
        this.clearPending(sessionKey)
      }
    }
  }

  private clearPending(sessionKey: string): void {
    const pending = this.pending.get(sessionKey)
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(sessionKey)
  }
}

/** 白名单投影：丢弃 raw、at 与未知字段。 */
export function projectEngineEvent(event: EngineEvent, seq: number, epoch: number): SessionEvent {
  switch (event.kind) {
    case 'message.delta':
      return { kind: 'message.delta', sessionId: event.sessionId, text: event.text, seq, epoch }
    case 'message.complete':
      return { kind: 'message.complete', sessionId: event.sessionId, text: event.text, seq, epoch }
    case 'tool.call':
      return {
        kind: 'tool.call',
        sessionId: event.sessionId,
        toolName: event.toolName,
        callId: event.callId,
        summary: event.summary,
        seq,
        epoch,
      }
    case 'tool.result':
      return {
        kind: 'tool.result',
        sessionId: event.sessionId,
        toolName: event.toolName,
        callId: event.callId,
        ok: event.ok,
        summary: event.summary,
        ...(event.outputFile === undefined ? {} : { outputFile: event.outputFile }),
        seq,
        epoch,
      }
    case 'compaction.start':
    case 'compaction.summary':
    case 'compaction.end':
      return { kind: event.kind, sessionId: event.sessionId, seq, epoch }
    case 'session.error':
      return {
        kind: 'session.error',
        sessionId: event.sessionId,
        error: {
          code: event.error.code,
          message: event.error.message,
          ...(event.error.rawCode === undefined ? {} : { rawCode: event.error.rawCode }),
          retryable: event.error.retryable,
        },
        seq,
        epoch,
      }
    case 'session.closed':
      return {
        kind: 'session.closed',
        sessionId: event.sessionId,
        reason: event.reason,
        seq,
        epoch,
      }
  }
}
