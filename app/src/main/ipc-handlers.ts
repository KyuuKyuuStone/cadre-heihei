/**
 * 主进程 IPC handler（frontend/02 §1/§4，只读第一层）。
 *
 * - 身份只取 windowId 绑定；renderer 输入出现 projectId/sessionId → INVALID_ARGUMENT；
 * - 所有 handler 返回 ApiOk/ApiFailure，不抛异常；未映射错误 → INTERNAL_ERROR + rawCode；
 * - 列表复用 collab/tools（DispatchService/台账），不在 IPC 层复制业务规则；
 * - 本单仅：whoami / listTasks / listRoster / prefs:get / prefs:set。
 */
import { randomUUID } from 'node:crypto'
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
  type ApiVersion,
  type ErrorCode,
  type InvalidArgumentFailure,
  type SendMessageReceipt,
  type SessionId,
  type TaskDetail,
  type TaskTransitionRecord,
} from '../collab/protocol/index.ts'
import { buildBodyReceipt } from '../collab/dispatch/index.ts'
import { handleToolCall } from '../collab/tools/handlers.ts'
import type { ToolBackend } from '../collab/tools/types.ts'
import type { EngineEvent, EngineSession } from '../ports/engine.ts'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  IPC_SESSION_TARGET_CHANNELS,
  isPreferenceLocale,
  isPreferenceTheme,
  type IpcChannel,
  type IpcIdentity,
  type IpcWhoamiResult,
  type PreferencesPatch,
} from '../shared/ipc.ts'
import type { IdentityBinding } from './identity.ts'
import type { PreferencesPort } from './preferences.ts'
import type { SessionEventPump } from './session-events.ts'

export type IpcOk = { readonly ok: true; readonly apiVersion: ApiVersion } & {
  readonly [key: string]: unknown
}
export type IpcResult = IpcOk | IpcWhoamiResult | ApiFailure

/** 会话访问端口：M2 registry 的结构型适配（避免 main 反向 import runtime）。 */
export interface SessionPort {
  get(sessionId: SessionId): EngineSession | undefined
  rebuild(sessionId: SessionId): Promise<EngineSession>
}

export interface IpcHandlerOptions {
  readonly binding: IdentityBinding
  readonly backend: ToolBackend
  readonly preferences: PreferencesPort
  readonly projectNameFor?: (projectId: string) => string
  readonly pump?: SessionEventPump
  readonly sessions?: SessionPort
  readonly now?: () => string
  readonly newId?: () => string
}

export interface IpcHandlerRegistry {
  handle(
    windowId: string,
    channel: IpcChannel | string,
    input?: unknown,
  ): IpcResult | Promise<IpcResult>
}

function failure(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): ApiFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: { ...extra, code, message, retryable: ERROR_RETRYABLE[code] },
  } as ApiFailure
}

function invalid(field: string, reason: string): InvalidArgumentFailure {
  return failure('INVALID_ARGUMENT', `参数非法：${field}`, { field, reason }) as InvalidArgumentFailure
}

function crossProjectDenied(projectId: string): ApiFailure {
  return failure('CROSS_PROJECT_DENIED', '身份不属于该项目', { projectId })
}

function internalError(error: unknown): ApiFailure {
  const record = error as { code?: unknown; name?: unknown }
  const rawCode =
    typeof record?.code === 'string'
      ? record.code
      : typeof record?.name === 'string'
        ? record.name
        : 'UNKNOWN'
  return failure('INTERNAL_ERROR', 'IPC 处理失败', { rawCode })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 身份/通道覆盖检测：own property 出现即拒绝（即使值为 undefined）。
 * sessionId 仅允许出现在会话目标通道（且 handler 会校验其等于绑定会话）。
 */
function overrideField(channel: string, input: unknown): string | undefined {
  if (!isPlainObject(input)) return undefined
  if (Object.prototype.hasOwnProperty.call(input, 'projectId')) return 'projectId'
  if (Object.prototype.hasOwnProperty.call(input, 'channel')) return 'channel'
  const sessionTargetAllowed = (IPC_SESSION_TARGET_CHANNELS as readonly string[]).includes(channel)
  if (!sessionTargetAllowed && Object.prototype.hasOwnProperty.call(input, 'sessionId')) {
    return 'sessionId'
  }
  return undefined
}

function stringField(
  args: Record<string, unknown>,
  field: string,
  options: { require?: boolean; allowEmpty?: boolean } = {},
): { ok: true; value: string | undefined } | { ok: false; failure: InvalidArgumentFailure } {
  const value = args[field]
  if (value === undefined) {
    return options.require === true
      ? { ok: false, failure: invalid(field, '缺少必填参数') }
      : { ok: true, value: undefined }
  }
  if (typeof value !== 'string') return { ok: false, failure: invalid(field, '必须是字符串') }
  if (options.allowEmpty !== true && value.trim() === '') {
    return { ok: false, failure: invalid(field, '不得为空') }
  }
  return { ok: true, value }
}

/** 会话目标必须等于窗口绑定会话，否则不泄露具体原因。 */
function sessionTarget(
  identity: IpcIdentity,
  args: Record<string, unknown>,
): { ok: true; sessionId: SessionId } | { ok: false; failure: ApiFailure } {
  const parsed = stringField(args, 'sessionId', { require: true })
  if (!parsed.ok) return { ok: false, failure: parsed.failure }
  const sessionId = parsed.value as SessionId
  if (sessionId !== identity.sessionId) {
    return {
      ok: false,
      failure: failure('FORBIDDEN_ACTOR', '只能操作窗口绑定的会话', {
        projectId: identity.projectId,
        actorSessionId: identity.sessionId,
        reasonCategory: 'not-owner',
        requiredActor: 'owner-session',
      }),
    }
  }
  return { ok: true, sessionId }
}

function emptyBodyFailure(): ApiFailure {
  return failure('EMPTY_BODY', '正文为空', { field: 'body' })
}

function toTaskDetail(payload: Record<string, unknown>): TaskDetail {
  const rawTransitions = Array.isArray(payload.transitions) ? payload.transitions : []
  const transitions: TaskTransitionRecord[] = rawTransitions.map((entry) => {
    const record = entry as Record<string, unknown>
    return {
      from: (record.from ?? null) as TaskTransitionRecord['from'],
      to: record.to as TaskTransitionRecord['to'],
      at: record.at as TaskTransitionRecord['at'],
      actorSessionId: record.actorSessionId as TaskTransitionRecord['actorSessionId'],
      ...(record.reason === undefined ? {} : { reason: String(record.reason) }),
      ...(record.eventId === undefined ? {} : { eventId: record.eventId as never }),
    }
  })
  const rawReport = payload.report
  const report =
    rawReport === null || rawReport === undefined
      ? null
      : (() => {
          const record = rawReport as Record<string, unknown>
          return {
            summary: String(record.summary ?? ''),
            deliverables: Array.isArray(record.deliverables)
              ? record.deliverables.map((item) => String(item))
              : [],
            bodyBytes: Number(record.bodyBytes ?? 0),
            preview: String(record.preview ?? ''),
            messageId: record.messageId as never,
          }
        })()
  return {
    taskId: payload.taskId as never,
    projectId: payload.projectId as never,
    seq: Number(payload.seq ?? 0),
    title: String(payload.title ?? ''),
    status: payload.status as never,
    assigneeSessionId: payload.assigneeSessionId as never,
    ...(payload.assigneeName === undefined ? {} : { assigneeName: String(payload.assigneeName) }),
    attempt: Number(payload.attempt ?? 0),
    updatedAt: payload.updatedAt as never,
    ...(payload.deliveredAt === undefined ? {} : { deliveredAt: payload.deliveredAt as never }),
    body: String(payload.body ?? ''),
    transitions,
    report,
    sourceSessionId: (payload.sourceSessionId ?? payload.dispatcherSessionId) as never,
    version: Number(payload.version ?? 0),
  }
}

type ParsedArgs =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly failure: InvalidArgumentFailure }

function inputObject(input: unknown): ParsedArgs {
  if (input === undefined || input === null) return { ok: true, value: {} }
  if (!isPlainObject(input)) return { ok: false, failure: invalid('input', '必须是 plain object') }
  return { ok: true, value: input }
}

type MemberRecord = ReturnType<ToolBackend['listMembers']>[number]

function callerMember(
  options: IpcHandlerOptions,
  identity: IpcIdentity,
): { ok: true; member: MemberRecord } | { ok: false; failure: ApiFailure } {
  const member = options.backend
    .listMembers(identity.projectId)
    .find((candidate) => candidate.sessionId === identity.sessionId)
  return member === undefined
    ? { ok: false, failure: crossProjectDenied(String(identity.projectId)) }
    : { ok: true, member }
}

export function createIpcHandlers(options: IpcHandlerOptions): IpcHandlerRegistry {
  // 每个会话当前 run 的“停止后续产出”控制器（harness 无 mid-turn cancel）。
  const activeRuns = new Map<SessionId, AbortController>()
  /**
   * session:send 进程内幂等缓存（U-IPC-02）：同键同 body 返回首次回执，
   * 不重复调用 EngineSession.send；同键异 body → IDEMPOTENCY_CONFLICT。
   * 仅进程内有效，跨主进程重启不保证（M4 再接持久化）。
   */
  const sendReplays = new Map<
    string,
    { readonly body: string; readonly receipt: SendMessageReceipt }
  >()
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? (() => randomUUID())

  const unavailable = (rawCode: string): ApiFailure =>
    failure('INTERNAL_ERROR', 'IPC 依赖不可用', { rawCode })

  const syntheticError = (sessionId: SessionId, error: unknown): EngineEvent => ({
    kind: 'session.error',
    sessionId,
    at: now() as never,
    error: {
      code: 'ENGINE_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawCode: 'SESSION_SEND_FAILED',
    },
  })

  return {
    handle(windowId, channel, input) {
      try {
        if (!(IPC_CHANNEL_VALUES as readonly string[]).includes(channel)) {
          return invalid('channel', `未知通道：${channel}`)
        }
        const override = overrideField(channel, input)
        if (override !== undefined) {
          return invalid(override, 'renderer 不得覆盖身份，身份只取窗口绑定')
        }

        const identity = options.binding.get(windowId)
        if (identity === undefined) return crossProjectDenied('')
        const membership = callerMember(options, identity)
        if (!membership.ok) return membership.failure

        switch (channel as IpcChannel) {
          case IPC_CHANNELS.whoami: {
            const result: IpcWhoamiResult = {
              ok: true,
              apiVersion: API_VERSION,
              projectId: identity.projectId,
              sessionId: identity.sessionId,
              role: identity.role,
              projectName: (options.projectNameFor ?? ((projectId) => projectId))(
                String(identity.projectId),
              ),
            }
            return result
          }

          case IPC_CHANNELS.listTasks:
          case IPC_CHANNELS.listRoster:
          case IPC_CHANNELS.getTask:
          case IPC_CHANNELS.dispatchTask:
          case IPC_CHANNELS.reportTask:
          case IPC_CHANNELS.reviewTask: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const toolName = {
              [IPC_CHANNELS.listTasks]: 'list_tasks',
              [IPC_CHANNELS.listRoster]: 'list_roster',
              [IPC_CHANNELS.getTask]: 'get_task',
              [IPC_CHANNELS.dispatchTask]: 'dispatch_task',
              [IPC_CHANNELS.reportTask]: 'report_task',
              [IPC_CHANNELS.reviewTask]: 'review_task',
            }[channel as string] as
              | 'list_tasks'
              | 'list_roster'
              | 'get_task'
              | 'dispatch_task'
              | 'report_task'
              | 'review_task'
            const result = handleToolCall(
              {
                identity: {
                  projectId: identity.projectId,
                  sessionId: identity.sessionId,
                },
                backend: options.backend,
              },
              toolName,
              parsed.value,
            )
            if (channel === IPC_CHANNELS.getTask) {
              if (result.isError) return result.payload as IpcResult
              return {
                ok: true,
                apiVersion: API_VERSION,
                ...toTaskDetail(result.payload as Record<string, unknown>),
              }
            }
            return result.payload as IpcResult
          }

          case IPC_CHANNELS.subscribeSession: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const target = sessionTarget(identity, parsed.value)
            if (!target.ok) return target.failure
            if (options.pump === undefined) return unavailable('PUMP_UNAVAILABLE')
            const { subscriptionId } = options.pump.subscribe(windowId, target.sessionId)
            return { ok: true, apiVersion: API_VERSION, subscriptionId }
          }

          case IPC_CHANNELS.unsubscribeSession: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const subscriptionId = stringField(parsed.value, 'subscriptionId', { require: true })
            if (!subscriptionId.ok) return subscriptionId.failure
            if (options.pump === undefined) return unavailable('PUMP_UNAVAILABLE')
            options.pump.unsubscribe(windowId, subscriptionId.value as string)
            return { ok: true, apiVersion: API_VERSION }
          }

          case IPC_CHANNELS.sendMessage: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const target = sessionTarget(identity, parsed.value)
            if (!target.ok) return target.failure
            const body = stringField(parsed.value, 'body', { require: true, allowEmpty: true })
            if (!body.ok) return body.failure
            if ((body.value as string).trim() === '') return emptyBodyFailure()
            const key = stringField(parsed.value, 'idempotencyKey')
            if (!key.ok) return key.failure
            const replayKey =
              key.value === undefined
                ? undefined
                : `${String(identity.projectId)}\u0000${String(target.sessionId)}\u0000${key.value}`
            const cached = replayKey === undefined ? undefined : sendReplays.get(replayKey)
            if (cached !== undefined) {
              if (cached.body !== (body.value as string)) {
                return failure('IDEMPOTENCY_CONFLICT', '幂等键已被不同正文占用', {
                  projectId: identity.projectId,
                })
              }
              return { ok: true, apiVersion: API_VERSION, ...cached.receipt }
            }
            if (options.sessions === undefined) return unavailable('SESSION_PORT_UNAVAILABLE')
            if (options.pump === undefined) return unavailable('PUMP_UNAVAILABLE')
            const session = options.sessions.get(target.sessionId)
            if (session === undefined) return unavailable('SESSION_NOT_FOUND')

            const controller = new AbortController()
            activeRuns.set(target.sessionId, controller)
            let iterable: AsyncIterable<EngineEvent>
            try {
              iterable = session.send(body.value as string, { signal: controller.signal })
            } catch (error) {
              activeRuns.delete(target.sessionId)
              return internalError(error)
            }
            const pump = options.pump
            void (async () => {
              try {
                for await (const event of iterable) pump.push(event)
              } catch (error) {
                // abort 后的异常属于预期（停止后续产出），不再伪报。
                if (!controller.signal.aborted) pump.push(syntheticError(target.sessionId, error))
              } finally {
                if (activeRuns.get(target.sessionId) === controller) {
                  activeRuns.delete(target.sessionId)
                }
              }
            })()

            const receipt: SendMessageReceipt = {
              ...buildBodyReceipt(body.value as string),
              messageId: newId() as never,
              acceptedAt: now() as never,
            }
            if (replayKey !== undefined) {
              sendReplays.set(replayKey, { body: body.value as string, receipt })
            }
            return { ok: true, apiVersion: API_VERSION, ...receipt }
          }

          case IPC_CHANNELS.interruptSession: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const target = sessionTarget(identity, parsed.value)
            if (!target.ok) return target.failure
            const controller = activeRuns.get(target.sessionId)
            if (controller === undefined) {
              // 无进行中的 run：如实返回 false，不伪报 interrupted=true。
              return { ok: true, apiVersion: API_VERSION, interrupted: false }
            }
            controller.abort()
            return { ok: true, apiVersion: API_VERSION, interrupted: true }
          }

          case IPC_CHANNELS.reconnectSession: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const target = sessionTarget(identity, parsed.value)
            if (!target.ok) return target.failure
            if (options.sessions === undefined) return unavailable('SESSION_PORT_UNAVAILABLE')
            if (options.pump === undefined) return unavailable('PUMP_UNAVAILABLE')
            const previous = options.sessions.get(target.sessionId)
            return options.sessions
              .rebuild(target.sessionId)
              .then((rebuilt) => {
                const recreated = previous === undefined || rebuilt !== previous
                if (recreated) options.pump?.bumpEpoch(target.sessionId)
                const { subscriptionId } = options.pump!.subscribe(windowId, target.sessionId)
                return {
                  ok: true,
                  apiVersion: API_VERSION,
                  subscriptionId,
                  recreated,
                } as IpcResult
              })
              .catch((error: unknown) => internalError(error))
          }

          case IPC_CHANNELS.sessionEvent:
            return invalid('channel', 'session:event 是 main→renderer 通道，不可 invoke')

          case IPC_CHANNELS.prefsGet:
            return {
              ok: true,
              apiVersion: API_VERSION,
              ...options.preferences.get(),
            }

          case IPC_CHANNELS.prefsSet: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const args = parsed.value
            const allowed = new Set(['locale', 'theme'])
            for (const key of Object.keys(args)) {
              if (!allowed.has(key)) return invalid(key, '未知偏好字段')
            }
            if (args.locale !== undefined && !isPreferenceLocale(args.locale)) {
              return invalid('locale', '不支持的 locale')
            }
            if (args.theme !== undefined && !isPreferenceTheme(args.theme)) {
              return invalid('theme', '不支持的 theme')
            }
            const patch: PreferencesPatch = {
              ...(args.locale === undefined ? {} : { locale: args.locale }),
              ...(args.theme === undefined ? {} : { theme: args.theme }),
            }
            options.preferences.set(patch)
            return { ok: true, apiVersion: API_VERSION }
          }
        }
      } catch (error) {
        return internalError(error)
      }
    },
  }
}
