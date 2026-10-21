/**
 * renderer 侧 IPC 契约补充（只读通道 + 写通道声明）。
 *
 * 来源：`docs/product/frontend/02-IPC与主进程契约.md` §1/§2/§5。
 * `app/src/shared/ipc.ts`（df84f8b）目前只落了 whoami/listTasks/listRoster/prefs，
 * 这里补齐 getTask、session:* 与 `window.cadre` 调用面；shared 落地后合并回共享层。
 * 本文件只含类型与常量，不 import Electron/Node/主进程实现。
 */
import type { ApiVersion, IsoTimestamp, SessionId, TaskId } from '../../collab/protocol/ids.ts'
import type { ApiFailure } from '../../collab/protocol/errors.ts'
import type { EmptyList } from '../../collab/protocol/common.ts'
import type { TaskStatus } from '../../collab/protocol/task-status.ts'
import type { TaskDetail, TaskSummary, SendMessageReceipt } from '../../collab/protocol/tool-outputs.ts'
import type { RosterResponse } from '../../collab/protocol/roster.ts'
import type { IpcWhoamiResult, Preferences, PreferencesPatch } from '../../shared/ipc.ts'

/** shared/ipc.ts 尚未包含的通道（文档 §1 第 5/10/13 条）。 */
export const RENDERER_IPC_CHANNELS = {
  getTask: 'collab:getTask',
  sessionSend: 'session:send',
  sessionEvent: 'session:event',
} as const

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

/** 主进程 → renderer 的会话事件白名单投影（文档 §5；不传 raw/harness payload）。 */
export type SessionEvent =
  | { readonly kind: 'message.delta'; readonly sessionId: SessionId; readonly text: string; readonly seq: number; readonly epoch?: number }
  | { readonly kind: 'message.complete'; readonly sessionId: SessionId; readonly text: string; readonly seq: number; readonly epoch?: number }
  | { readonly kind: 'tool.call'; readonly sessionId: SessionId; readonly toolName: string; readonly callId: string; readonly summary: string; readonly seq: number }
  | { readonly kind: 'tool.result'; readonly sessionId: SessionId; readonly toolName: string; readonly callId: string; readonly ok: boolean; readonly summary: string; readonly outputFile?: string; readonly seq: number }
  | { readonly kind: 'compaction.start' | 'compaction.summary' | 'compaction.end'; readonly sessionId: SessionId; readonly seq: number }
  | {
    readonly kind: 'session.error'
    readonly sessionId: SessionId
    readonly error: { readonly code: string; readonly message: string; readonly rawCode?: string; readonly retryable: boolean }
    readonly seq: number
  }
  | { readonly kind: 'session.closed'; readonly sessionId: SessionId; readonly reason: string; readonly seq: number }

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
