/** preload 白名单桥：方法集合、通道映射、校验复用、事件取消。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CADRE_BRIDGE_METHODS, IPC_CHANNELS } from '../../src/shared/ipc.ts'
import { createCadreBridge, type BridgeTransport } from '../../src/preload/bridge.ts'

function fakeTransport() {
  const calls: Array<{ channel: string; payload: unknown }> = []
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const transport: BridgeTransport = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload })
      return { ok: true }
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
  }
  return { transport, calls, listeners }
}

test('方法集合与 CADRE_BRIDGE_METHODS 完全一致（15 个）', () => {
  const bridge = createCadreBridge(fakeTransport().transport)
  assert.deepEqual(Object.keys(bridge).sort(), [...CADRE_BRIDGE_METHODS].sort())
  assert.equal(Object.keys(bridge).length, 15)
  for (const method of ['interruptSession', 'reconnectSession', 'onSessionEvent'] as const) {
    assert.equal(typeof bridge[method], 'function', `${method} 必须暴露`)
  }
})

test('renderer CadreBridge 已声明的 13 个方法均在 preload 桥中', () => {
  // 与 src/renderer/data/ipcContract.ts 的 CadreBridge 接口同名（renderer 只读）；
  // interruptSession/reconnectSession 由 frontend/02 §2 补齐，共 15 个。
  const rendererDeclared = [
    'whoami',
    'listTasks',
    'getTask',
    'listRoster',
    'getPreferences',
    'setPreferences',
    'sendMessage',
    'subscribeSession',
    'unsubscribeSession',
    'onSessionEvent',
    'dispatchTask',
    'reportTask',
    'reviewTask',
  ]
  const bridge = createCadreBridge(fakeTransport().transport) as unknown as Record<string, unknown>
  for (const method of rendererDeclared) {
    assert.equal(typeof bridge[method], 'function', `缺少 CadreBridge 方法：${method}`)
  }
})

test('每个方法映射到正确通道', async () => {
  const cases: Array<[keyof ReturnType<typeof createCadreBridge>, string, unknown]> = [
    ['whoami', IPC_CHANNELS.whoami, undefined],
    ['dispatchTask', IPC_CHANNELS.dispatchTask, {}],
    ['reportTask', IPC_CHANNELS.reportTask, {}],
    ['listTasks', IPC_CHANNELS.listTasks, {}],
    ['getTask', IPC_CHANNELS.getTask, {}],
    ['listRoster', IPC_CHANNELS.listRoster, {}],
    ['reviewTask', IPC_CHANNELS.reviewTask, {}],
    ['subscribeSession', IPC_CHANNELS.subscribeSession, {}],
    ['unsubscribeSession', IPC_CHANNELS.unsubscribeSession, {}],
    ['sendMessage', IPC_CHANNELS.sendMessage, {}],
    ['interruptSession', IPC_CHANNELS.interruptSession, {}],
    ['reconnectSession', IPC_CHANNELS.reconnectSession, {}],
    ['getPreferences', IPC_CHANNELS.prefsGet, undefined],
    ['setPreferences', IPC_CHANNELS.prefsSet, {}],
  ]
  for (const [method, channel, input] of cases) {
    const { transport, calls } = fakeTransport()
    const bridge = createCadreBridge(transport)
    const fn = bridge[method] as (value?: unknown) => Promise<unknown>
    await fn(input)
    assert.equal(calls.length, 1, method)
    assert.equal(calls[0]!.channel, channel, method)
  }
})

test('内部复用校验器：坏值/身份覆盖不送 invoke', async () => {
  const { transport, calls } = fakeTransport()
  const bridge = createCadreBridge(transport)

  const fnInput = (await bridge.listTasks({ status: () => 1 })) as any
  assert.equal(fnInput.error.code, 'INVALID_ARGUMENT')
  const override = (await bridge.listTasks({ projectId: 'p2' })) as any
  assert.equal(override.error.code, 'INVALID_ARGUMENT')
  assert.equal(override.error.field, 'projectId')
  const sessionTarget = (await bridge.subscribeSession({ sessionId: 's', lastSeq: 3 })) as any
  assert.equal(sessionTarget.ok, true, '会话通道允许目标 sessionId')
  assert.equal(calls.length, 1)
})

test('transport 异常 → INTERNAL_ERROR，不 reject', async () => {
  const bridge = createCadreBridge({
    invoke: () => Promise.reject(new Error('ipc gone')),
    on: () => () => {},
  })
  const result = (await bridge.whoami()) as any
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.equal(result.error.rawCode, 'IPC_INVOKE_FAILED')
  assert.equal(JSON.stringify(result).includes('ipc gone'), false)
})

test('onSessionEvent：订阅 session:event，返回取消函数', () => {
  const { transport, listeners } = fakeTransport()
  const bridge = createCadreBridge(transport)
  const received: unknown[] = []
  const off = bridge.onSessionEvent((event) => received.push(event))
  const set = listeners.get(IPC_CHANNELS.sessionEvent)!
  assert.equal(set.size, 1)
  const event = { kind: 'message.delta', sessionId: 's', text: 'x', seq: 1, epoch: 1 }
  for (const listener of set) listener(event)
  assert.deepEqual(received, [event])
  off()
  assert.equal(set.size, 0)
})
