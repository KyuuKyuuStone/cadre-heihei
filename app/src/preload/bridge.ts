/**
 * `window.cadre` 白名单桥（纯函数，不 import electron，可用 fake transport 单测）。
 *
 * 只暴露 frontend/02 §2 的 15 个方法；每次 invoke 前复用 validate.ts。
 * 不暴露 ipcRenderer / process / require / Buffer。
 */
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
} from '../collab/protocol/index.ts'
import {
  CADRE_BRIDGE_METHODS,
  IPC_CHANNELS,
  type CadreBridgeMethod,
  type SessionEvent,
} from '../shared/ipc.ts'
import { validateIpcInput } from './validate.ts'

export interface BridgeTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>
  on(channel: string, listener: (event: unknown) => void): () => void
}

export interface CadreBridgeImpl {
  whoami(): Promise<unknown>
  dispatchTask(input: unknown): Promise<unknown>
  reportTask(input: unknown): Promise<unknown>
  listTasks(input?: unknown): Promise<unknown>
  getTask(input: unknown): Promise<unknown>
  listRoster(input?: unknown): Promise<unknown>
  reviewTask(input: unknown): Promise<unknown>
  subscribeSession(input: unknown): Promise<unknown>
  unsubscribeSession(input: unknown): Promise<unknown>
  sendMessage(input: unknown): Promise<unknown>
  interruptSession(input: unknown): Promise<unknown>
  reconnectSession(input: unknown): Promise<unknown>
  onSessionEvent(callback: (event: SessionEvent) => void): () => void
  getPreferences(): Promise<unknown>
  setPreferences(input: unknown): Promise<unknown>
}

export { CADRE_BRIDGE_METHODS }
export type { CadreBridgeMethod }

function invokeFailure(rawCode: string): ApiFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'IPC 调用失败',
      retryable: ERROR_RETRYABLE.INTERNAL_ERROR,
      rawCode,
    },
  } as ApiFailure
}

export function createCadreBridge(transport: BridgeTransport): CadreBridgeImpl {
  const call = (channel: string, input: unknown): Promise<unknown> => {
    const validated = validateIpcInput(channel, input)
    if (!validated.ok) return Promise.resolve(validated)
    return Promise.resolve()
      .then(() => transport.invoke(channel, validated.value))
      .catch(() => invokeFailure('IPC_INVOKE_FAILED'))
  }

  return {
    whoami: () => call(IPC_CHANNELS.whoami, undefined),
    dispatchTask: (input) => call(IPC_CHANNELS.dispatchTask, input),
    reportTask: (input) => call(IPC_CHANNELS.reportTask, input),
    listTasks: (input) => call(IPC_CHANNELS.listTasks, input),
    getTask: (input) => call(IPC_CHANNELS.getTask, input),
    listRoster: (input) => call(IPC_CHANNELS.listRoster, input),
    reviewTask: (input) => call(IPC_CHANNELS.reviewTask, input),
    subscribeSession: (input) => call(IPC_CHANNELS.subscribeSession, input),
    unsubscribeSession: (input) => call(IPC_CHANNELS.unsubscribeSession, input),
    sendMessage: (input) => call(IPC_CHANNELS.sendMessage, input),
    interruptSession: (input) => call(IPC_CHANNELS.interruptSession, input),
    reconnectSession: (input) => call(IPC_CHANNELS.reconnectSession, input),
    onSessionEvent: (callback) =>
      transport.on(IPC_CHANNELS.sessionEvent, (event) => callback(event as SessionEvent)),
    getPreferences: () => call(IPC_CHANNELS.prefsGet, undefined),
    setPreferences: (input) => call(IPC_CHANNELS.prefsSet, input),
  }
}
