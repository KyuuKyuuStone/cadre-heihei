/**
 * preload 输入白名单校验器（纯函数，无 electron/node 依赖）。
 *
 * 只放行 JSON 类值：string / finite number / boolean / null / 数组 / plain object。
 * 拒绝 function、Symbol、BigInt、undefined、Date/Map/Set/RegExp/类实例、循环引用；
 * 拒绝 renderer 覆盖身份（projectId/sessionId）；请求体上限 1 MB。
 * 结构校验不复制业务规则（业务校验在主进程 handler）。
 */
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
  type InvalidArgumentFailure,
} from '../collab/protocol/index.ts'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  IPC_FORBIDDEN_INPUT_FIELDS,
  IPC_MAX_PAYLOAD_BYTES,
  IPC_SESSION_TARGET_CHANNELS,
  type IpcChannel,
} from '../shared/ipc.ts'

export type IpcValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | InvalidArgumentFailure

function invalid(field: string, reason: string): InvalidArgumentFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'INVALID_ARGUMENT',
      message: `参数非法：${field}`,
      retryable: ERROR_RETRYABLE.INVALID_ARGUMENT,
      field,
      reason,
    },
  } as InvalidArgumentFailure
}

function typeName(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

interface Violation {
  readonly field: string
  readonly reason: string
}

function visit(value: unknown, path: string, seen: WeakSet<object>): Violation | undefined {
  if (value === null) return undefined
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : { field: path, reason: 'number 必须有限' }
    case 'undefined':
      return { field: path, reason: 'undefined 不是 JSON 类值' }
    case 'bigint':
      return { field: path, reason: 'BigInt 不允许跨 IPC' }
    case 'symbol':
      return { field: path, reason: 'Symbol 不允许跨 IPC' }
    case 'function':
      return { field: path, reason: 'function 不允许跨 IPC' }
    case 'object':
      break
    default:
      return { field: path, reason: `不支持的类型：${typeName(value)}` }
  }

  const object = value as object
  if (seen.has(object)) return { field: path, reason: '循环引用不允许跨 IPC' }
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index += 1) {
        if (!(index in object)) return { field: `${path}[${index}]`, reason: '稀疏数组不允许跨 IPC' }
        const violation = visit(object[index], `${path}[${index}]`, seen)
        if (violation !== undefined) return violation
      }
      return undefined
    }
    if (!isPlainObject(object)) {
      const ctor = (object as { constructor?: { name?: unknown } }).constructor
      return {
        field: path,
        reason: `只接受 plain object（收到 ${typeof ctor?.name === 'string' ? ctor.name : typeName(object)}）`,
      }
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      return { field: path, reason: 'Symbol 键不允许跨 IPC' }
    }
    for (const key of Object.keys(object)) {
      let child: unknown
      try {
        child = (object as Record<string, unknown>)[key]
      } catch {
        return { field: `${path}.${key}`, reason: '属性不可读' }
      }
      const violation = visit(child, path === 'input' ? `input.${key}` : `${path}.${key}`, seen)
      if (violation !== undefined) return violation
    }
    return undefined
  } finally {
    seen.delete(object)
  }
}

function serializedBytes(value: unknown): number {
  if (value === undefined) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return new TextEncoder().encode(text).length
}

const NO_ARG_CHANNELS = new Set<string>([IPC_CHANNELS.whoami, IPC_CHANNELS.prefsGet])

/**
 * 校验 preload → main 的输入。
 * - 无参通道（whoami/prefs:get）允许 undefined/null；
 * - 其余通道要求 plain object（undefined/null 视为空对象）；
 * - 所有通道拒绝身份覆盖字段与非 JSON 类值。
 */
export function validateIpcInput(
  channel: IpcChannel | string,
  input: unknown,
): IpcValidationResult {
  if (!(IPC_CHANNEL_VALUES as readonly string[]).includes(channel)) {
    return invalid('channel', `未知通道：${String(channel)}`)
  }

  const noArgs = NO_ARG_CHANNELS.has(channel)
  if (input === undefined || input === null) {
    return { ok: true, value: noArgs ? undefined : {} }
  }
  if (!noArgs && !isPlainObject(input)) {
    return invalid('input', `必须传 plain object（收到 ${typeName(input)}）`)
  }

  // 身份/通道覆盖优先判定：即便值为 undefined，也报具体字段而不是 input.xxx。
  if (isPlainObject(input)) {
    const forbidden = IPC_FORBIDDEN_INPUT_FIELDS.find((field) =>
      Object.prototype.hasOwnProperty.call(input, field),
    )
    if (forbidden !== undefined) {
      return invalid(
        forbidden,
        forbidden === 'channel' ? 'renderer 不得指定事件通道' : 'renderer 不得覆盖身份',
      )
    }
    const sessionTargetAllowed = (IPC_SESSION_TARGET_CHANNELS as readonly string[]).includes(channel)
    if (!sessionTargetAllowed && Object.prototype.hasOwnProperty.call(input, 'sessionId')) {
      return invalid('sessionId', 'renderer 不得覆盖身份')
    }
  }

  const seen = new WeakSet<object>()
  const violation = visit(input, 'input', seen)
  if (violation !== undefined) return invalid(violation.field, violation.reason)

  if (serializedBytes(input) > IPC_MAX_PAYLOAD_BYTES) {
    return invalid('payload', `请求体超过 ${IPC_MAX_PAYLOAD_BYTES} 字节上限`)
  }
  return { ok: true, value: noArgs ? undefined : input }
}

/** 供测试/白名单直接判断值本身是否为 JSON 类值。 */
export function isJsonLikeValue(value: unknown): boolean {
  return visit(value, 'value', new WeakSet<object>()) === undefined
}

export type { ApiFailure }
