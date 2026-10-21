/** Electron IPC 薄层：windowId 来源、二次校验、错误包装、事件 sink。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_VERSION } from '../../src/collab/protocol/index.ts'
import type { IpcHandlerRegistry, IpcResult } from '../../src/main/ipc-handlers.ts'
import {
  ELECTRON_INVOKE_CHANNELS,
  createWindowEventSink,
  registerElectronIpc,
  type MiniWindow,
} from '../../src/main/electron-ipc.ts'
import type { SessionEvent } from '../../src/shared/ipc.ts'

type Listener = (event: { sender: unknown }, ...args: unknown[]) => unknown

function fakeIpcMain() {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    ipcMain: {
      handle(channel: string, listener: Listener) {
        listeners.set(channel, listener)
      },
    },
  }
}

function fakeHandlers(result: IpcResult = { ok: true, apiVersion: API_VERSION } as IpcResult) {
  const calls: Array<{ windowId: string; channel: string; input: unknown }> = []
  const handlers: IpcHandlerRegistry = {
    handle(windowId, channel, input) {
      calls.push({ windowId, channel, input })
      return result
    },
  }
  return { handlers, calls }
}

test('注册全部可 invoke 通道，排除 session:event', () => {
  const { ipcMain, listeners } = fakeIpcMain()
  const channels = registerElectronIpc({
    ipcMain,
    fromWebContents: () => ({ id: 1 }),
    handlers: fakeHandlers().handlers,
  })
  assert.deepEqual([...channels], [...ELECTRON_INVOKE_CHANNELS])
  assert.equal(channels.includes('session:event'), false)
  assert.equal(listeners.size, 14)
})

test('windowId 取不到 → INTERNAL_ERROR，不进入 handler', async () => {
  const { ipcMain, listeners } = fakeIpcMain()
  const { handlers, calls } = fakeHandlers()
  registerElectronIpc({ ipcMain, fromWebContents: () => null, handlers })
  const result = (await listeners.get('app:whoami')!({ sender: {} })) as any
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.equal(result.error.rawCode, 'WINDOW_ID_UNAVAILABLE')
  assert.equal('stack' in result.error, false)
  assert.equal(calls.length, 0)
})

test('Electron 层二次校验：坏输入不进入 handler', async () => {
  const { ipcMain, listeners } = fakeIpcMain()
  const { handlers, calls } = fakeHandlers()
  registerElectronIpc({ ipcMain, fromWebContents: () => ({ id: 7 }), handlers })
  const result = (await listeners.get('collab:listTasks')!(
    { sender: {} },
    { nested: { fn: () => 1 } },
  )) as any
  assert.equal(result.error.code, 'INVALID_ARGUMENT')
  assert.equal(result.error.field, 'input.nested.fn')
  assert.equal(calls.length, 0)
})

test('成功路径：windowId 转字符串并传快照', async () => {
  const { ipcMain, listeners } = fakeIpcMain()
  const { handlers, calls } = fakeHandlers({
    ok: true,
    apiVersion: API_VERSION,
    projectId: 'p',
  } as unknown as IpcResult)
  registerElectronIpc({ ipcMain, fromWebContents: () => ({ id: 42 }), handlers })
  const input = { status: ['review'] }
  const result = (await listeners.get('collab:listTasks')!({ sender: {} }, input)) as any
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.windowId, '42')
  assert.equal(calls[0]!.channel, 'collab:listTasks')
  assert.deepEqual(calls[0]!.input, { status: ['review'] })
  assert.notEqual(calls[0]!.input, input, 'handler 收到快照而非原对象')
})

test('handler 抛错 → INTERNAL_ERROR + rawCode，不带堆栈', async () => {
  const { ipcMain, listeners } = fakeIpcMain()
  const handlers: IpcHandlerRegistry = {
    handle() {
      throw new Error('boom')
    },
  }
  registerElectronIpc({ ipcMain, fromWebContents: () => ({ id: 1 }), handlers })
  const result = (await listeners.get('app:whoami')!({ sender: {} })) as any
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.equal(result.error.rawCode, 'HANDLER_UNEXPECTED')
  assert.equal(JSON.stringify(result).includes('boom'), false)
})

test('事件 sink：正常转发；窗口销毁/不存在时静默丢弃', () => {
  const sent: Array<{ id: number; channel: string; event: SessionEvent }> = []
  const window: MiniWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, event) => sent.push({ id: 1, channel, event }) },
  }
  const destroyed: MiniWindow = {
    isDestroyed: () => true,
    webContents: { send: () => assert.fail('销毁窗口不得发送') },
  }
  const windows = new Map<number, MiniWindow>([
    [1, window],
    [2, destroyed],
  ])
  const sink = createWindowEventSink((id) => windows.get(id))
  const event: SessionEvent = {
    kind: 'message.complete',
    sessionId: 's' as never,
    text: 'ok',
    seq: 1,
    epoch: 1,
  }
  sink('1', 'session:event', event)
  sink('2', 'session:event', event)
  sink('404', 'session:event', event)
  sink('1', 'other:channel' as never, event)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.channel, 'session:event')
  assert.deepEqual(sent[0]!.event, event)
})
