/**
 * IPC 通道名与跨层类型（preload / renderer / main 共享）。
 * 本文件只含常量与类型，不 import electron / node / collab 实现。
 */
import type { ApiVersion, ProjectId, SessionId } from '../collab/protocol/ids.ts'

export const IPC_CHANNELS = {
  whoami: 'app:whoami',
  listTasks: 'collab:listTasks',
  getTask: 'collab:getTask',
  listRoster: 'collab:listRoster',
  dispatchTask: 'collab:dispatchTask',
  reportTask: 'collab:reportTask',
  reviewTask: 'collab:reviewTask',
  subscribeSession: 'session:subscribe',
  unsubscribeSession: 'session:unsubscribe',
  sendMessage: 'session:send',
  interruptSession: 'session:interrupt',
  reconnectSession: 'session:reconnect',
  sessionEvent: 'session:event',
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
export const IPC_CHANNEL_VALUES: readonly IpcChannel[] = Object.values(IPC_CHANNELS)

/** renderer 不得覆盖的身份字段：出现即 INVALID_ARGUMENT。 */
export const IPC_IDENTITY_FIELDS = ['projectId', 'sessionId'] as const
export type IpcIdentityField = (typeof IPC_IDENTITY_FIELDS)[number]

/** 会话通道允许把 sessionId 当目标（仍须等于窗口绑定会话）。 */
export const IPC_SESSION_TARGET_CHANNELS = [
  IPC_CHANNELS.subscribeSession,
  IPC_CHANNELS.sendMessage,
  IPC_CHANNELS.interruptSession,
  IPC_CHANNELS.reconnectSession,
] as const

/** renderer 不得指定事件通道。 */
export const IPC_FORBIDDEN_INPUT_FIELDS = ['projectId', 'channel'] as const

/** 请求体上限（U-IPC-10）。 */
export const IPC_MAX_PAYLOAD_BYTES = 1024 * 1024

/** preload 暴露在 `window.cadre` 上的方法全集（frontend/02 §2，15 个）。 */
export const CADRE_BRIDGE_METHODS = [
  'whoami',
  'dispatchTask',
  'reportTask',
  'listTasks',
  'getTask',
  'listRoster',
  'reviewTask',
  'subscribeSession',
  'unsubscribeSession',
  'sendMessage',
  'interruptSession',
  'reconnectSession',
  'onSessionEvent',
  'getPreferences',
  'setPreferences',
] as const
export type CadreBridgeMethod = (typeof CADRE_BRIDGE_METHODS)[number]

export type IpcRole = 'supervisor' | 'worker'

export interface IpcIdentity {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly role: IpcRole
}

export interface IpcWhoamiResult {
  readonly ok: true
  readonly apiVersion: ApiVersion
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly role: IpcRole
  readonly projectName: string
}

export const PREFERENCE_LOCALES = ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const
export type PreferenceLocale = (typeof PREFERENCE_LOCALES)[number]

export const PREFERENCE_THEMES = [
  'white',
  'paper',
  'warm-classic',
  'celadon',
  'ink-blue',
  'dark',
] as const
export type PreferenceTheme = (typeof PREFERENCE_THEMES)[number]

export interface Preferences {
  readonly locale: PreferenceLocale
  readonly theme: PreferenceTheme
}

export interface PreferencesPatch {
  readonly locale?: PreferenceLocale
  readonly theme?: PreferenceTheme
}

export const DEFAULT_PREFERENCES: Preferences = { locale: 'en', theme: 'white' }

export function isPreferenceLocale(value: unknown): value is PreferenceLocale {
  return typeof value === 'string' && (PREFERENCE_LOCALES as readonly string[]).includes(value)
}

export function isPreferenceTheme(value: unknown): value is PreferenceTheme {
  return typeof value === 'string' && (PREFERENCE_THEMES as readonly string[]).includes(value)
}

/** main → renderer 的会话事件（白名单投影，不含 raw / harness 原始 payload）。 */
export interface SessionEventBase {
  readonly sessionId: SessionId
  /** 每会话单调递增；重建后随 epoch 重置。 */
  readonly seq: number
  /** 重建代次，从 1 开始；递增表示实例已重建。 */
  readonly epoch: number
}

export type SessionEvent =
  | (SessionEventBase & { readonly kind: 'message.delta'; readonly text: string })
  | (SessionEventBase & { readonly kind: 'message.complete'; readonly text: string })
  | (SessionEventBase & {
      readonly kind: 'tool.call'
      readonly toolName: string
      readonly callId: string
      readonly summary: string
    })
  | (SessionEventBase & {
      readonly kind: 'tool.result'
      readonly toolName: string
      readonly callId: string
      readonly ok: boolean
      readonly summary: string
      readonly outputFile?: string
    })
  | (SessionEventBase & { readonly kind: 'compaction.start' | 'compaction.summary' | 'compaction.end' })
  | (SessionEventBase & {
      readonly kind: 'session.error'
      readonly error: {
        readonly code: string
        readonly message: string
        readonly rawCode?: string
        readonly retryable: boolean
      }
    })
  | (SessionEventBase & {
      readonly kind: 'session.closed'
      readonly reason: 'requested' | 'crashed' | 'unknown'
    })
