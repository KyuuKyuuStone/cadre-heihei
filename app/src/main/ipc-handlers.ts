/**
 * 主进程 IPC handler（frontend/02 §1/§4，只读第一层）。
 *
 * - 身份只取 windowId 绑定；renderer 输入出现 projectId/sessionId → INVALID_ARGUMENT；
 * - 所有 handler 返回 ApiOk/ApiFailure，不抛异常；未映射错误 → INTERNAL_ERROR + rawCode；
 * - 列表复用 collab/tools（DispatchService/台账），不在 IPC 层复制业务规则；
 * - 本单仅：whoami / listTasks / listRoster / prefs:get / prefs:set。
 */
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
  type ApiVersion,
  type ErrorCode,
  type InvalidArgumentFailure,
} from '../collab/protocol/index.ts'
import { handleToolCall } from '../collab/tools/handlers.ts'
import type { ToolBackend } from '../collab/tools/types.ts'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  IPC_IDENTITY_FIELDS,
  isPreferenceLocale,
  isPreferenceTheme,
  type IpcChannel,
  type IpcIdentity,
  type IpcWhoamiResult,
  type PreferencesPatch,
} from '../shared/ipc.ts'
import type { IdentityBinding } from './identity.ts'
import type { PreferencesPort } from './preferences.ts'

export type IpcOk = { readonly ok: true; readonly apiVersion: ApiVersion } & {
  readonly [key: string]: unknown
}
export type IpcResult = IpcOk | IpcWhoamiResult | ApiFailure

export interface IpcHandlerOptions {
  readonly binding: IdentityBinding
  readonly backend: ToolBackend
  readonly preferences: PreferencesPort
  readonly projectNameFor?: (projectId: string) => string
}

export interface IpcHandlerRegistry {
  handle(windowId: string, channel: IpcChannel | string, input?: unknown): IpcResult
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

/** 身份覆盖检测：own property 出现即拒绝（即使值为 undefined）。 */
function identityOverride(input: unknown): (typeof IPC_IDENTITY_FIELDS)[number] | undefined {
  if (!isPlainObject(input)) return undefined
  return IPC_IDENTITY_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(input, field))
}

type ParsedArgs =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly failure: InvalidArgumentFailure }

function inputObject(input: unknown): ParsedArgs {
  if (input === undefined || input === null) return { ok: true, value: {} }
  if (!isPlainObject(input)) return { ok: false, failure: invalid('input', '必须是 plain object') }
  return { ok: true, value: input }
}

function callerMember(
  options: IpcHandlerOptions,
  identity: IpcIdentity,
): { ok: true } | { ok: false; failure: ApiFailure } {
  const member = options.backend
    .listMembers(identity.projectId)
    .find((candidate) => candidate.sessionId === identity.sessionId)
  return member === undefined
    ? { ok: false, failure: crossProjectDenied(String(identity.projectId)) }
    : { ok: true }
}

export function createIpcHandlers(options: IpcHandlerOptions): IpcHandlerRegistry {
  return {
    handle(windowId, channel, input) {
      try {
        if (!(IPC_CHANNEL_VALUES as readonly string[]).includes(channel)) {
          return invalid('channel', `未知通道：${channel}`)
        }
        const override = identityOverride(input)
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
          case IPC_CHANNELS.listRoster: {
            const parsed = inputObject(input)
            if (!parsed.ok) return parsed.failure
            const toolName = channel === IPC_CHANNELS.listTasks ? 'list_tasks' : 'list_roster'
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
            return result.payload as IpcResult
          }

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
