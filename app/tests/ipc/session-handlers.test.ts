/** 会话 IPC：订阅/发送/中断/重连与事件泵接线（假会话 + 假 registry，无 Electron/harness）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryDispatchService } from '../../src/collab/dispatch/index.ts'
import type { EngineEvent, EngineSession, SendOptions } from '../../src/ports/engine.ts'
import type { SessionId } from '../../src/collab/protocol/index.ts'
import { InMemoryIdentityBinding } from '../../src/main/identity.ts'
import { InMemoryPreferencesStore } from '../../src/main/preferences.ts'
import { createIpcHandlers, type SessionPort } from '../../src/main/ipc-handlers.ts'
import { SessionEventPump } from '../../src/main/session-events.ts'
import type { SessionEvent } from '../../src/shared/ipc.ts'
import { EMP, MCP_MEMBERS, P1, SUP, seedTasks } from '../mcp/seed.ts'
import type { IpcResult } from '../../src/main/ipc-handlers.ts'

const AT = '2026-10-21T00:00:00.000Z'
const WIN = 'win-1'

interface Captured {
  readonly windowId: string
  readonly event: SessionEvent
}

function delta(text: string): EngineEvent {
  return { kind: 'message.delta', sessionId: EMP, at: AT as never, text }
}
function complete(text: string): EngineEvent {
  return { kind: 'message.complete', sessionId: EMP, at: AT as never, text }
}

class FakeSession implements EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId = 'runtime-fake'
  readonly prompts: Array<{ body: string; signal?: AbortSignal }> = []
  scripts: EngineEvent[][]

  constructor(sessionId: SessionId = EMP, scripts: EngineEvent[][] = []) {
    this.sessionId = sessionId
    this.scripts = scripts
  }

  send(body: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    this.prompts.push({ body, ...(options?.signal === undefined ? {} : { signal: options.signal }) })
    const script = this.scripts.shift() ?? []
    return (async function* () {
      for (const event of script) yield event
    })()
  }

  async setWorkingDirectory(): Promise<void> {}
  async getWorkingDirectory(): Promise<string> {
    return '/work'
  }
  async close(): Promise<void> {}
}

class HangingSession implements EngineSession {
  readonly sessionId = EMP
  readonly runtimeId = 'runtime-hanging'
  signal: AbortSignal | undefined

  send(_body: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    this.signal = options?.signal
    const signal = options?.signal
    return (async function* () {
      yield delta('partial')
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })()
  }

  async setWorkingDirectory(): Promise<void> {}
  async getWorkingDirectory(): Promise<string> {
    return '/work'
  }
  async close(): Promise<void> {}
}

function makePort(initial: EngineSession) {
  const port = {
    current: initial,
    fail: false,
    next: undefined as EngineSession | undefined,
    get(): EngineSession | undefined {
      return this.current
    },
    async rebuild(): Promise<EngineSession> {
      if (this.fail) throw Object.assign(new Error('rebuild failed'), { code: 'E_REBUILD' })
      const rebuilt = this.next ?? new FakeSession(EMP)
      this.next = undefined
      this.current = rebuilt
      return rebuilt
    },
  }
  return port satisfies SessionPort
}

function setup(initial: EngineSession = new FakeSession()) {
  const service = new InMemoryDispatchService({
    members: MCP_MEMBERS,
    serverVersion: 'ipc-session-test',
  })
  seedTasks(service)
  const binding = new InMemoryIdentityBinding()
  binding.bind(WIN, { projectId: P1, sessionId: EMP, role: 'worker' })
  const captured: Captured[] = []
  const pump = new SessionEventPump({
    sink: (windowId, _channel, event) => captured.push({ windowId, event }),
  })
  const port = makePort(initial)
  const handlers = createIpcHandlers({
    binding,
    backend: service,
    preferences: new InMemoryPreferencesStore(),
    pump,
    sessions: port,
    now: () => AT,
    newId: () => `msg-${Math.random().toString(36).slice(2)}` as never,
  })
  const call = async (channel: string, input?: unknown): Promise<IpcResult> =>
    handlers.handle(WIN, channel, input)
  return {
    service,
    binding,
    captured,
    pump,
    port,
    call,
    cleanup() {
      pump.dispose()
      ;(service as { close?: () => void }).close?.()
    },
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('订阅去重 + send 回执 + 事件泵投影', async () => {
  const session = new FakeSession(EMP, [[delta('he'), delta('llo'), complete('hello')]])
  const ctx = setup(session)
  try {
    const first = (await ctx.call('session:subscribe', { sessionId: EMP })) as any
    const second = (await ctx.call('session:subscribe', { sessionId: EMP })) as any
    assert.equal(first.ok, true)
    assert.equal(first.subscriptionId, second.subscriptionId)

    const receipt = (await ctx.call('session:send', {
      sessionId: EMP,
      body: '  hello  ',
      idempotencyKey: 'send-1',
    })) as any
    assert.equal(receipt.ok, true)
    assert.equal(receipt.bodyBytes, 9, 'bodyBytes 不去空白')
    assert.equal(receipt.preview, 'hello')
    assert.equal(typeof receipt.bodySha256, 'string')
    assert.equal(receipt.bodySha256.length, 64)
    assert.equal(typeof receipt.messageId, 'string')
    assert.equal(receipt.acceptedAt, AT)
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]!.body, '  hello  ')

    await settle()
    ctx.pump.flush()
    assert.deepEqual(
      ctx.captured.map((entry) => entry.event.kind),
      ['message.delta', 'message.complete'],
    )
    const merged = ctx.captured[0]!.event
    assert.equal(merged.kind === 'message.delta' ? merged.text : '', 'hello')
    assert.equal(merged.seq, 1)
    assert.equal(merged.epoch, 1)
    assert.equal(ctx.captured[1]!.event.seq, 2)
  } finally {
    ctx.cleanup()
  }
})

test('空正文 EMPTY_BODY；目标会话越权 FORBIDDEN；覆盖字段 INVALID_ARGUMENT', async () => {
  const session = new FakeSession()
  const ctx = setup(session)
  try {
    const empty = (await ctx.call('session:send', { sessionId: EMP, body: '   ' })) as any
    assert.equal(empty.error.code, 'EMPTY_BODY')
    assert.equal(empty.error.field, 'body')
    assert.equal(session.prompts.length, 0)

    const wrongTarget = (await ctx.call('session:subscribe', {
      sessionId: SUP,
    })) as any
    assert.equal(wrongTarget.error.code, 'FORBIDDEN_ACTOR')
    assert.equal(wrongTarget.error.reasonCategory, 'not-owner')

    const wrongSend = (await ctx.call('session:send', {
      sessionId: SUP,
      body: 'hi',
    })) as any
    assert.equal(wrongSend.error.code, 'FORBIDDEN_ACTOR')

    const spoofProject = (await ctx.call('session:send', {
      projectId: P1,
      sessionId: EMP,
      body: 'hi',
    })) as any
    assert.equal(spoofProject.error.code, 'INVALID_ARGUMENT')
    assert.equal(spoofProject.error.field, 'projectId')

    const spoofChannel = (await ctx.call('session:send', {
      channel: 'session:event',
      sessionId: EMP,
      body: 'hi',
    })) as any
    assert.equal(spoofChannel.error.code, 'INVALID_ARGUMENT')
    assert.equal(spoofChannel.error.field, 'channel')

    const eventInvoke = (await ctx.call('session:event')) as any
    assert.equal(eventInvoke.error.code, 'INVALID_ARGUMENT')
    assert.equal(eventInvoke.error.field, 'channel')
  } finally {
    ctx.cleanup()
  }
})

test('取消订阅 / 窗口销毁后不再投递', async () => {
  const ctx = setup()
  try {
    const sub = (await ctx.call('session:subscribe', { sessionId: EMP })) as any
    ctx.pump.push(complete('one'))
    assert.equal(ctx.captured.length, 1)

    const unsubscribe = (await ctx.call('session:unsubscribe', {
      subscriptionId: sub.subscriptionId,
    })) as any
    assert.equal(unsubscribe.ok, true)
    ctx.pump.push(complete('two'))
    assert.equal(ctx.captured.length, 1)

    // 幂等：未知 subscriptionId 仍返回 ok。
    const again = (await ctx.call('session:unsubscribe', {
      subscriptionId: 'sub-unknown',
    })) as any
    assert.equal(again.ok, true)

    await ctx.call('session:subscribe', { sessionId: EMP })
    ctx.pump.dropWindow(WIN)
    ctx.pump.push(complete('three'))
    assert.equal(ctx.captured.length, 1)
  } finally {
    ctx.cleanup()
  }
})

test('interrupt：有进行中 run → true 并 abort；空闲 → false', async () => {
  const session = new HangingSession()
  const ctx = setup(session)
  try {
    await ctx.call('session:subscribe', { sessionId: EMP })
    await ctx.call('session:send', { sessionId: EMP, body: 'long run' })
    await settle()
    assert.equal(session.signal?.aborted, false)
    const interrupted = (await ctx.call('session:interrupt', { sessionId: EMP })) as any
    assert.equal(interrupted.ok, true)
    assert.equal(interrupted.interrupted, true)
    assert.equal(session.signal?.aborted, true)
    await settle()

    const idle = (await ctx.call('session:interrupt', { sessionId: EMP })) as any
    assert.equal(idle.interrupted, false, '无进行中 run 时不得伪报 true')
  } finally {
    ctx.cleanup()
  }
})

test('reconnect：重建成功 → recreated + epoch 递增；失败 → INTERNAL_ERROR', async () => {
  const original = new FakeSession()
  const ctx = setup(original)
  try {
    const sub = (await ctx.call('session:subscribe', { sessionId: EMP })) as any
    const rebuilt = new FakeSession()
    ctx.port.next = rebuilt
    const result = (await ctx.call('session:reconnect', { sessionId: EMP })) as any
    assert.equal(result.ok, true)
    assert.equal(result.recreated, true)
    assert.equal(result.subscriptionId, sub.subscriptionId, '重连复用订阅')

    ctx.pump.push(complete('after-rebuild'))
    const event = ctx.captured.at(-1)!.event
    assert.equal(event.epoch, 2)
    assert.equal(event.seq, 1)

    ctx.port.fail = true
    const failed = (await ctx.call('session:reconnect', { sessionId: EMP })) as any
    assert.equal(failed.error.code, 'INTERNAL_ERROR')
    assert.equal(failed.error.rawCode, 'E_REBUILD')
  } finally {
    ctx.cleanup()
  }
})

test('send 幂等：同键同 body 不重复 send/不重复推事件；异 body 冲突；不同键放行', async () => {
  const session = new FakeSession(EMP, [
    [delta('a'), complete('a')],
    [complete('b')],
  ])
  const ctx = setup(session)
  try {
    await ctx.call('session:subscribe', { sessionId: EMP })
    const request = { sessionId: EMP, body: 'a', idempotencyKey: 'send-idem-1' }
    const first = (await ctx.call('session:send', request)) as any
    assert.equal(first.ok, true)
    await settle()
    ctx.pump.flush()
    const eventsAfterFirst = ctx.captured.length
    assert.equal(session.prompts.length, 1)

    const replay = (await ctx.call('session:send', request)) as any
    assert.deepEqual(replay, first, '同键同 body 返回首次回执')
    assert.equal(session.prompts.length, 1, '重放不得再次调用 send')
    await settle()
    ctx.pump.flush()
    assert.equal(ctx.captured.length, eventsAfterFirst, '重放不得重复推事件')

    const conflict = (await ctx.call('session:send', {
      sessionId: EMP,
      body: 'b',
      idempotencyKey: 'send-idem-1',
    })) as any
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal(session.prompts.length, 1)

    const differentKey = (await ctx.call('session:send', {
      sessionId: EMP,
      body: 'b',
      idempotencyKey: 'send-idem-2',
    })) as any
    assert.equal(differentKey.ok, true)
    assert.equal(session.prompts.length, 2, '不同键应放行')
    await settle()
    ctx.pump.flush()
    assert.ok(ctx.captured.length > eventsAfterFirst)
  } finally {
    ctx.cleanup()
  }
})

test('send 事件流抛错 → 合成 session.error，handler 不抛出', async () => {
  const throwing: EngineSession = {
    sessionId: EMP,
    runtimeId: 'runtime-throw',
    send: () =>
      (async function* () {
        yield delta('x')
        throw new Error('engine stream died')
      })(),
    async setWorkingDirectory() {},
    async getWorkingDirectory() {
      return '/work'
    },
    async close() {},
  }
  const ctx = setup(throwing)
  try {
    await ctx.call('session:subscribe', { sessionId: EMP })
    const receipt = (await ctx.call('session:send', { sessionId: EMP, body: 'go' })) as any
    assert.equal(receipt.ok, true)
    await settle()
    ctx.pump.flush()
    const error = ctx.captured.find((entry) => entry.event.kind === 'session.error')
    assert.ok(error !== undefined)
    if (error?.event.kind === 'session.error') {
      assert.equal(error.event.error.rawCode, 'SESSION_SEND_FAILED')
      assert.match(error.event.error.message, /engine stream died/)
    }
  } finally {
    ctx.cleanup()
  }
})
