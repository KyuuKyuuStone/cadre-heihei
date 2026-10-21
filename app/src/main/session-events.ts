/**
 * 会话事件泵（frontend/02 §5）：EngineEvent → SessionEvent 白名单投影。
 *
 * - 不传 raw / harness 原始 payload；
 * - message.delta 默认 16ms 合并；complete/error/closed 立即 flush；
 * - 每会话单调 seq；重建（bumpEpoch）后 epoch+1、seq 从 0 重新计数；
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

export type SessionEventSink = (
  windowId: string,
  channel: SessionEventChannel,
  event: SessionEvent,
) => void

export interface SessionEventPumpOptions {
  readonly sink: SessionEventSink
  /** delta 合并窗口（U-IPC-05：16–32ms，默认 16）。 */
  readonly deltaThrottleMs?: number
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
  timer?: NodeJS.Timeout
}

export interface SubscribeResult {
  readonly subscriptionId: string
  readonly created: boolean
}

function stateKey(sessionId: SessionId): string {
  return String(sessionId)
}

function subscriptionKey(windowId: string, sessionId: SessionId): string {
  return `${windowId}\u0000${String(sessionId)}`
}

export class SessionEventPump {
  private readonly sink: SessionEventSink
  private readonly deltaThrottleMs: number
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byWindowSession = new Map<string, string>()
  private readonly bySession = new Map<string, Set<string>>()
  private readonly states = new Map<string, SessionState>()
  private readonly pending = new Map<string, PendingDelta>()

  constructor(options: SessionEventPumpOptions) {
    this.sink = options.sink
    this.deltaThrottleMs = options.deltaThrottleMs ?? 16
  }

  subscribe(windowId: string, sessionId: SessionId): SubscribeResult {
    const key = subscriptionKey(windowId, sessionId)
    const existing = this.byWindowSession.get(key)
    if (existing !== undefined && this.subscriptions.has(existing)) {
      return { subscriptionId: existing, created: false }
    }
    const subscription: Subscription = { id: `sub-${randomUUID()}`, windowId, sessionId }
    this.subscriptions.set(subscription.id, subscription)
    this.byWindowSession.set(key, subscription.id)
    const sessionKey = stateKey(sessionId)
    const set = this.bySession.get(sessionKey) ?? new Set<string>()
    set.add(subscription.id)
    this.bySession.set(sessionKey, set)
    return { subscriptionId: subscription.id, created: true }
  }

  /** 只允许订阅窗口自己的 subscription；未知 id 幂等返回 false。 */
  unsubscribe(windowId: string, subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined || subscription.windowId !== windowId) return false
    this.removeSubscription(subscription)
    return true
  }

  /** 窗口销毁：移除该窗口全部订阅与待发 delta。 */
  dropWindow(windowId: string): number {
    let removed = 0
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.windowId !== windowId) continue
      this.removeSubscription(subscription)
      removed += 1
    }
    return removed
  }

  /** 会话重建：epoch+1、seq 归零，清掉旧代次待发 delta。 */
  bumpEpoch(sessionId: SessionId): number {
    const key = stateKey(sessionId)
    const current = this.states.get(key)?.epoch ?? 1
    this.clearPending(key)
    this.states.set(key, { epoch: current + 1, seq: 0 })
    return current + 1
  }

  push(event: EngineEvent): void {
    const sessionKey = stateKey(event.sessionId)
    if (event.kind === 'message.delta') {
      this.appendDelta(sessionKey, event.text)
      return
    }
    // 非 delta：先把积压 delta 发出，保证顺序，再立即发本事件。
    this.flushSession(event.sessionId)
    this.emit(event)
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
  }

  private appendDelta(sessionKey: string, text: string): void {
    if (this.subscribersFor(sessionKey).length === 0) return
    const pending = this.pending.get(sessionKey) ?? { text: '' }
    pending.text += text
    if (pending.timer === undefined) {
      pending.timer = setTimeout(() => {
        pending.timer = undefined
        this.flushSessionByKey(sessionKey)
      }, this.deltaThrottleMs)
      pending.timer.unref?.()
    }
    this.pending.set(sessionKey, pending)
  }

  private flushSession(sessionId: SessionId): void {
    this.flushSessionByKey(stateKey(sessionId))
  }

  private flushSessionByKey(sessionKey: string): void {
    const pending = this.pending.get(sessionKey)
    if (pending === undefined) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(sessionKey)
    if (pending.text === '') return
    const sessionId = String(sessionKey)
    this.deliver(sessionKey, (seq, epoch) => ({
      kind: 'message.delta',
      sessionId: sessionId as SessionId,
      text: pending.text,
      seq,
      epoch,
    }))
  }

  private emit(event: EngineEvent): void {
    const sessionKey = stateKey(event.sessionId)
    if (this.subscribersFor(sessionKey).length === 0) return
    this.deliver(sessionKey, (seq, epoch) => projectEngineEvent(event, seq, epoch))
  }

  private deliver(
    sessionKey: string,
    project: (seq: number, epoch: number) => SessionEvent,
  ): void {
    const state = this.states.get(sessionKey) ?? { epoch: 1, seq: 0 }
    state.seq += 1
    this.states.set(sessionKey, state)
    const event = project(state.seq, state.epoch)
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
    // 仅当 map 仍指向该订阅时才删除去重键（防止误删新订阅）。
    const key = subscriptionKey(subscription.windowId, subscription.sessionId)
    if (this.byWindowSession.get(key) === subscription.id) this.byWindowSession.delete(key)
    const sessionKey = stateKey(subscription.sessionId)
    const set = this.bySession.get(sessionKey)
    if (set !== undefined) {
      set.delete(subscription.id)
      if (set.size === 0) {
        this.bySession.delete(sessionKey)
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
