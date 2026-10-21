/**
 * CadreApi：renderer 的数据访问面。
 * 默认实现只读 `window.cadre`（preload 白名单）；renderer 不 import Electron/Node。
 * 测试通过 Provider 注入 fake，不启动 Electron。
 */
import type { ApiFailure } from '../../collab/protocol/errors.ts'
import type { SessionId, TaskId } from '../../collab/protocol/ids.ts'
import type { Preferences, PreferencesPatch } from '../../shared/ipc.ts'
import type {
  CadreBridge,
  DispatchResponse,
  DispatchTaskInput,
  GetTaskResponse,
  ListRosterResponse,
  ListTasksQuery,
  ListTasksResponse,
  PreferencesResponse,
  ReportResponse,
  ReportTaskInput,
  ReviewResponse,
  ReviewTaskInput,
  SendMessageResponse,
  SessionEvent,
  SetPreferencesResponse,
  SubscribeSessionResponse,
  WhoamiResponse,
} from './ipcContract.ts'

export interface CadreApi {
  /** preload 是否已注入；false 时写通道禁用、偏好回落 localStorage。 */
  readonly available: boolean
  whoami(): Promise<WhoamiResponse>
  listTasks(query: ListTasksQuery): Promise<ListTasksResponse>
  listRoster(input: { readonly scope?: 'project' | 'global' }): Promise<ListRosterResponse>
  getTask(input: { readonly taskId: TaskId }): Promise<GetTaskResponse>
  getPreferences(): Promise<PreferencesResponse>
  setPreferences(patch: PreferencesPatch): Promise<SetPreferencesResponse>
  // 写通道：preload 落地前可能不存在，调用方必须先检查。
  sendMessage?(input: {
    readonly sessionId: SessionId
    readonly body: string
    readonly idempotencyKey?: string
  }): Promise<SendMessageResponse>
  subscribeSession?(input: { readonly sessionId: SessionId }): Promise<SubscribeSessionResponse>
  unsubscribeSession?(input: { readonly subscriptionId: string }): Promise<{ readonly ok: true } | ApiFailure>
  onSessionEvent?(callback: (event: SessionEvent) => void): () => void
  dispatchTask?(input: DispatchTaskInput): Promise<DispatchResponse>
  reportTask?(input: ReportTaskInput): Promise<ReportResponse>
  reviewTask?(input: ReviewTaskInput): Promise<ReviewResponse>
}

function notConnectedFailure(): ApiFailure {
  return {
    ok: false,
    apiVersion: 'cadre-heihei/1',
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Not connected to main process (window.cadre is missing)',
      retryable: false,
    },
  }
}

function readWindowBridge(): CadreBridge | undefined {
  return (globalThis as { cadre?: CadreBridge }).cadre
}

export function createWindowCadreApi(bridge: CadreBridge | undefined = readWindowBridge()): CadreApi {
  if (!bridge) return unavailableCadreApi
  return {
    available: true,
    whoami: () => bridge.whoami(),
    listTasks: (query) => bridge.listTasks(query),
    listRoster: (input) => bridge.listRoster(input),
    getTask: (input) => bridge.getTask(input),
    getPreferences: () => bridge.getPreferences(),
    setPreferences: (patch) => bridge.setPreferences(patch),
    ...(bridge.sendMessage ? { sendMessage: (input) => bridge.sendMessage!(input) } : {}),
    ...(bridge.subscribeSession ? { subscribeSession: (input) => bridge.subscribeSession!(input) } : {}),
    ...(bridge.unsubscribeSession ? { unsubscribeSession: (input) => bridge.unsubscribeSession!(input) } : {}),
    ...(bridge.onSessionEvent ? { onSessionEvent: (cb) => bridge.onSessionEvent!(cb) } : {}),
    ...(bridge.dispatchTask ? { dispatchTask: (input) => bridge.dispatchTask!(input) } : {}),
    ...(bridge.reportTask ? { reportTask: (input) => bridge.reportTask!(input) } : {}),
    ...(bridge.reviewTask ? { reviewTask: (input) => bridge.reviewTask!(input) } : {}),
  }
}

/** 未连接时的安全默认：只读调用返回结构化失败，写通道不暴露。 */
export const unavailableCadreApi: CadreApi = {
  available: false,
  whoami: async () => notConnectedFailure(),
  listTasks: async () => notConnectedFailure(),
  listRoster: async () => notConnectedFailure(),
  getTask: async () => notConnectedFailure(),
  getPreferences: async () => notConnectedFailure(),
  setPreferences: async () => notConnectedFailure(),
}
