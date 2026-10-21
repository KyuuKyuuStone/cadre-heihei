/**
 * renderer 侧的 IPC 调用面与响应包装。
 *
 * 单一事实源：通道常量与 SessionEvent 来自 `app/src/shared/ipc.ts`（35a2527），
 * renderer 不再本地重复定义，避免两套契约漂移（W1 返工）。
 * 本文件只保留「成功即 ok:true」的响应包装（文档 §0）与 `window.cadre` 调用面；
 * 不 import Electron/Node/主进程实现。
 */
import type { ApiVersion, IsoTimestamp, SessionId, TaskId } from '../../collab/protocol/ids.ts'
import type { ApiFailure } from '../../collab/protocol/errors.ts'
import type { EmptyList } from '../../collab/protocol/common.ts'
import type { TaskStatus } from '../../collab/protocol/task-status.ts'
import type { TaskDetail, TaskSummary, SendMessageReceipt } from '../../collab/protocol/tool-outputs.ts'
import type { RosterResponse } from '../../collab/protocol/roster.ts'
import {
  IPC_CHANNELS,
  type IpcWhoamiResult,
  type Preferences,
  type PreferencesPatch,
  type SessionEvent,
} from '../../shared/ipc.ts'

export type { SessionEvent }

/**
 * renderer 实际引用的通道（从 shared 常量取值，不写字面量）。
 * 一致性测试逐项核对 IPC_CHANNELS 与文档，防止任一侧漂移。
 */
export const RENDERER_CHANNEL_USAGE = {
  whoami: IPC_CHANNELS.whoami,
  listTasks: IPC_CHANNELS.listTasks,
  getTask: IPC_CHANNELS.getTask,
  listRoster: IPC_CHANNELS.listRoster,
  sendMessage: IPC_CHANNELS.sendMessage,
  subscribeSession: IPC_CHANNELS.subscribeSession,
  unsubscribeSession: IPC_CHANNELS.unsubscribeSession,
  sessionEvent: IPC_CHANNELS.sessionEvent,
  prefsGet: IPC_CHANNELS.prefsGet,
  prefsSet: IPC_CHANNELS.prefsSet,
} as const

/**
 * SessionEvent 的全部 kind（编译期与 shared 穷尽对齐）：
 * shared 若新增/删除 kind，这里的 `SESSION_EVENT_KINDS_COMPLETE` 会类型报错。
 */
export const SESSION_EVENT_KINDS = [
  'message.delta',
  'message.complete',
  'tool.call',
  'tool.result',
  'compaction.start',
  'compaction.summary',
  'compaction.end',
  'session.error',
  'session.closed',
] as const satisfies readonly SessionEvent['kind'][]

type UncoveredSessionEventKind = Exclude<SessionEvent['kind'], (typeof SESSION_EVENT_KINDS)[number]>
export const SESSION_EVENT_KINDS_COMPLETE: UncoveredSessionEventKind extends never ? true : false = true

export interface ListTasksQuery {
  readonly status?: TaskStatus
  readonly assigneeSessionId?: SessionId
  readonly since?: IsoTimestamp
  readonly limit?: number
}

/** 成功返回摘要数组或协议空列表；失败一律 ApiFailure（不 reject）。 */
export type TaskListPayload =
  | { readonly items: readonly TaskSummary[]; readonly empty?: false }
  | EmptyList<TaskSummary>

export type ListTasksResponse =
  | ({ readonly ok: true; readonly apiVersion: ApiVersion } & TaskListPayload)
  | ApiFailure

export type ListRosterResponse = RosterResponse | ApiFailure

export type WhoamiResponse = IpcWhoamiResult | ApiFailure
// 文档 §0：成功一律带 ok:true，以下类型本身无判别字段，故在调用面包装。
export type GetTaskResponse = ({ readonly ok: true } & TaskDetail) | ApiFailure
export type PreferencesResponse = ({ readonly ok: true } & Preferences) | ApiFailure
export type SetPreferencesResponse = { readonly ok: true } | ApiFailure
export type SendMessageResponse = ({ readonly ok: true } & SendMessageReceipt) | ApiFailure
export type SubscribeSessionResponse = { readonly ok: true; readonly subscriptionId: string } | ApiFailure

/** preload 白名单调用面（文档 §2）；写通道在 preload 落地前为可选。 */
export interface CadreBridge {
  whoami(): Promise<WhoamiResponse>
  listTasks(query: ListTasksQuery): Promise<ListTasksResponse>
  getTask(input: { readonly taskId: TaskId }): Promise<GetTaskResponse>
  listRoster(input: { readonly scope?: 'project' | 'global' }): Promise<ListRosterResponse>
  getPreferences(): Promise<PreferencesResponse>
  setPreferences(patch: PreferencesPatch): Promise<SetPreferencesResponse>
  sendMessage?(input: {
    readonly sessionId: SessionId
    readonly body: string
    readonly idempotencyKey?: string
  }): Promise<SendMessageResponse>
  subscribeSession?(input: { readonly sessionId: SessionId }): Promise<SubscribeSessionResponse>
  unsubscribeSession?(input: { readonly subscriptionId: string }): Promise<{ readonly ok: true } | ApiFailure>
  onSessionEvent?(callback: (event: SessionEvent) => void): () => void
}

export type { RosterResponse, TaskDetail, TaskSummary, TaskStatus, EmptyList, ApiFailure }
