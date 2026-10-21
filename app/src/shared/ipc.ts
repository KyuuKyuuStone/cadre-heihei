/**
 * IPC 通道名与跨层类型（preload / renderer / main 共享）。
 * 本文件只含常量与类型，不 import electron / node / collab 实现。
 */
import type { ApiVersion, ProjectId, SessionId } from '../collab/protocol/ids.ts'

export const IPC_CHANNELS = {
  whoami: 'app:whoami',
  listTasks: 'collab:listTasks',
  listRoster: 'collab:listRoster',
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
export const IPC_CHANNEL_VALUES: readonly IpcChannel[] = Object.values(IPC_CHANNELS)

/** renderer 不得覆盖的身份字段：出现即 INVALID_ARGUMENT。 */
export const IPC_IDENTITY_FIELDS = ['projectId', 'sessionId'] as const
export type IpcIdentityField = (typeof IPC_IDENTITY_FIELDS)[number]

/** 请求体上限（U-IPC-10）。 */
export const IPC_MAX_PAYLOAD_BYTES = 1024 * 1024

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
