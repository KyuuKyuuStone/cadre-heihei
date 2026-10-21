/**
 * Electron ↔ IPC 薄接线（无 electron import，可用 fake ipcMain 直测）。
 *
 * 硬要求（frontend/02 §3）：
 * - windowId 只取 BrowserWindow.fromWebContents(event.sender)?.id，取不到即拒绝；
 * - 入口重新跑 validateIpcInput（不信任 preload）；
 * - 任何异常统一 ApiFailure(INTERNAL_ERROR)，不带堆栈。
 */
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
} from '../collab/protocol/index.ts'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  type SessionEvent,
} from '../shared/ipc.ts'
import { validateIpcInput } from '../preload/validate.ts'
import type { IpcHandlerRegistry } from './ipc-handlers.ts'
import {
  SESSION_EVENT_CHANNEL,
  type SessionEventSink,
} from './session-events.ts'

export const ELECTRON_INVOKE_CHANNELS: readonly string[] = IPC_CHANNEL_VALUES.filter(
  (channel) => channel !== IPC_CHANNELS.sessionEvent,
)

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: { readonly sender: unknown }, ...args: unknown[]) => unknown,
  ): void
}

export interface WebContentsHolder {
  readonly id: number
}

export interface ElectronIpcOptions {
  readonly ipcMain: IpcMainLike
  readonly fromWebContents: (sender: unknown) => WebContentsHolder | null | undefined
  readonly handlers: IpcHandlerRegistry
  readonly channels?: readonly string[]
}

export function internalFailure(rawCode: string): ApiFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'IPC 处理失败',
      retryable: ERROR_RETRYABLE.INTERNAL_ERROR,
      rawCode,
    },
  } as ApiFailure
}

export function registerElectronIpc(options: ElectronIpcOptions): readonly string[] {
  const channels = options.channels ?? ELECTRON_INVOKE_CHANNELS
  for (const channel of channels) {
    options.ipcMain.handle(channel, async (event, ...args) => {
      const windowId = options.fromWebContents(event.sender)?.id
      if (typeof windowId !== 'number' || !Number.isFinite(windowId)) {
        return internalFailure('WINDOW_ID_UNAVAILABLE')
      }
      const validated = validateIpcInput(channel, args[0])
      if (!validated.ok) return validated
      try {
        return await options.handlers.handle(String(windowId), channel, validated.value)
      } catch {
        return internalFailure('HANDLER_UNEXPECTED')
      }
    })
  }
  return channels
}

export interface MiniWindow {
  isDestroyed(): boolean
  readonly webContents: {
    send(channel: string, event: SessionEvent): void
  }
}

/** pump sink：窗口不存在/已销毁时静默丢弃（不向上抛，避免打断事件泵）。 */
export function createWindowEventSink(
  getWindow: (windowId: number) => MiniWindow | undefined,
): SessionEventSink {
  return (windowId, channel, event) => {
    if (channel !== SESSION_EVENT_CHANNEL) return
    const window = getWindow(Number(windowId))
    if (window === undefined || window.isDestroyed()) return
    try {
      window.webContents.send(channel, event)
    } catch {
      // 窗口销毁竞态：只丢这一条事件，不影响 run。
    }
  }
}
