/**
 * preload 输入白名单校验器（纯函数，无 electron/node 依赖）。
 *
 * 只放行 JSON 类值：string / finite number / boolean / null / 数组 / plain object。
 * 拒绝 function、Symbol、BigInt、undefined、Date/Map/Set/RegExp/类实例、循环引用；
 * 拒绝 renderer 覆盖身份（projectId/sessionId）与指定 channel；请求体上限 1 MB。
 *
 * 校验同时**生成一次性快照**：getter 只求值一次，主进程拿到的是纯数据，
 * 避免 getter 多次求值造成 TOCTOU。深度上限 20 层、总节点上限 10000。
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

/** 校验深度上限（含根，根为 0）。 */
export const IPC_MAX_DEPTH = 20
/** 单次请求的最大值节点数（含基本类型）。 */
export const IPC_MAX_NODES = 10_000

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

type SanitizeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly violation: Violation }

interface VisitState {
  nodes: number
  readonly seen: WeakSet<object>
}

function sanitize(value: unknown, path: string, depth: number, state: VisitState): SanitizeResult {
  state.nodes += 1
  if (state.nodes > IPC_MAX_NODES) {
    return {
      ok: false,
      violation: { field: path, reason: `超过最大节点数 ${IPC_MAX_NODES}` },
    }
  }
  if (depth > IPC_MAX_DEPTH) {
    return { ok: false, violation: { field: path, reason: `嵌套超过 ${IPC_MAX_DEPTH} 层` } }
  }

  if (value === null) return { ok: true, value: null }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { ok: true, value }
    case 'number':
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, violation: { field: path, reason: 'number 必须有限' } }
    case 'undefined':
      return { ok: false, violation: { field: path, reason: 'undefined 不是 JSON 类值' } }
    case 'bigint':
      return { ok: false, violation: { field: path, reason: 'BigInt 不允许跨 IPC' } }
    case 'symbol':
      return { ok: false, violation: { field: path, reason: 'Symbol 不允许跨 IPC' } }
    case 'function':
      return { ok: false, violation: { field: path, reason: 'function 不允许跨 IPC' } }
    case 'object':
      break
    default:
      return { ok: false, violation: { field: path, reason: `不支持的类型：${typeName(value)}` } }
  }

  const object = value as object
  if (state.seen.has(object)) {
    return { ok: false, violation: { field: path, reason: '循环引用不允许跨 IPC' } }
  }
  state.seen.add(object)
  try {
    if (Array.isArray(object)) {
      const out: unknown[] = []
      for (let index = 0; index < object.length; index += 1) {
        if (!(index in object)) {
          return { ok: false, violation: { field: `${path}[${index}]`, reason: '稀疏数组不允许跨 IPC' } }
        }
        const child = sanitize(object[index], `${path}[${index}]`, depth + 1, state)
        if (!child.ok) return child
        out.push(child.value)
      }
      return { ok: true, value: out }
    }
    if (!isPlainObject(object)) {
      const ctor = (object as { constructor?: { name?: unknown } }).constructor
      return {
        ok: false,
        violation: {
          field: path,
          reason: `只接受 plain object（收到 ${typeof ctor?.name === 'string' ? ctor.name : typeName(object)}）`,
        },
      }
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      return { ok: false, violation: { field: path, reason: 'Symbol 键不允许跨 IPC' } }
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(object)) {
      let childValue: unknown
      try {
        // 只读取一次；随后用普通属性写入快照，getter 不再被求值。
        childValue = (object as Record<string, unknown>)[key]
      } catch {
        return { ok: false, violation: { field: `${path}.${key}`, reason: '属性不可读' } }
      }
      const childPath = path === 'input' ? `input.${key}` : `${path}.${key}`
      const child = sanitize(childValue, childPath, depth + 1, state)
      if (!child.ok) return child
      out[key] = child.value
    }
    return { ok: true, value: out }
  } finally {
    state.seen.delete(object)
  }
}

function serializedBytes(value: unknown): number {
  if (value === undefined) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return new TextEncoder().encode(text).length
}

const NO_ARG_CHANNELS = new Set<string>([IPC_CHANNELS.whoami, IPC_CHANNELS.prefsGet])

/**
 * 校验 preload → main 的输入，并返回快照。
 * - 无参通道（whoami/prefs:get）允许 undefined/null；
 * - 其余通道要求 plain object（undefined/null 视为空对象）；
 * - 所有通道拒绝身份/通道覆盖字段与非 JSON 类值。
 * 校验器自身异常也映射为 INVALID_ARGUMENT，不向调用方抛裸异常。
 */
export function validateIpcInput(
  channel: IpcChannel | string,
  input: unknown,
): IpcValidationResult {
  try {
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

    const snapshot = sanitize(input, 'input', 0, { nodes: 0, seen: new WeakSet<object>() })
    if (!snapshot.ok) return invalid(snapshot.violation.field, snapshot.violation.reason)

    if (serializedBytes(snapshot.value) > IPC_MAX_PAYLOAD_BYTES) {
      return invalid('payload', `请求体超过 ${IPC_MAX_PAYLOAD_BYTES} 字节上限`)
    }
    return { ok: true, value: noArgs ? undefined : snapshot.value }
  } catch {
    return invalid('input', '校验器内部异常')
  }
}

/** 供测试/白名单直接判断值本身是否为 JSON 类值（只校验，不保留快照）。 */
export function isJsonLikeValue(value: unknown): boolean {
  return sanitize(value, 'value', 0, { nodes: 0, seen: new WeakSet<object>() }).ok
}

export type { ApiFailure }
