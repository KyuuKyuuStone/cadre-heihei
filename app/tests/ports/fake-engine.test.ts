import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '../../src/collab/protocol/ids.ts'
import { FakeEngine, type FakeScriptEvent } from '../../src/adapters/engine/fake/index.ts'
import type { EngineEvent } from '../../src/ports/engine.ts'
import { runPortContractSuite } from './contract-shared.ts'

async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function isCode(code: string) {
  return (error: unknown): boolean => codeOf(error) === code
}

// ── M2 §2.3：fake 侧跑双实现共有契约 shared suite（harness 侧同一套断言见 scripts/m2-port-contract/run.ts）──
runPortContractSuite({
  name: 'fake',
  makeEngine: () => new FakeEngine(),
  makeWorkDir: (tag) => `/work/${tag}`,
  setSessionScript: (engine, sessionId, events) =>
    (engine as FakeEngine).setSessionScript(sessionId, events as FakeScriptEvent[]),
}, test)

// ── 以下为 fake 专有行为（脚本事件注入/abort/错误流终结/未映射错误）；
//    harness 侧不适用（真实 harness 无脚本注入面），在 M2 契约报告的 not-applicable 清单中列明。──

test('abort stops production and does not hang', async () => {
  const engine = new FakeEngine({ eventDelayMs: 5 })
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  engine.setSessionScript(session.sessionId, [
    { kind: 'message.delta', text: 'one' },
    { kind: 'message.delta', text: 'two' },
    { kind: 'message.complete', text: 'three' },
  ] as FakeScriptEvent[])

  const controller = new AbortController()
  const received: EngineEvent[] = []
  for await (const event of session.send('x', { signal: controller.signal })) {
    received.push(event)
    controller.abort()
  }
  assert.equal(received.length, 1)
  assert.equal(received[0]!.kind, 'message.delta')

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  assert.deepEqual(await collect(session.send('x', { signal: alreadyAborted.signal })), [])
})

test('scripted event kinds are yielded with per-session ids', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  engine.setSessionScript(session.sessionId, [
    { kind: 'message.delta', text: 'd' },
    { kind: 'tool.call', toolName: 'tool', callId: 'c1', summary: 'call' },
    { kind: 'tool.result', toolName: 'tool', callId: 'c1', ok: true, summary: 'ok' },
    { kind: 'compaction.start', raw: { phase: 'start' } },
    { kind: 'compaction.summary', raw: { phase: 'summary' } },
    { kind: 'compaction.end', raw: { phase: 'end' } },
    { kind: 'message.complete', text: 'done' },
  ] as FakeScriptEvent[])

  const events = await collect(session.send('x'))
  assert.deepEqual(events.map((event) => event.kind), [
    'message.delta',
    'tool.call',
    'tool.result',
    'compaction.start',
    'compaction.summary',
    'compaction.end',
    'message.complete',
  ])
  assert.ok(events.every((event) => event.sessionId === session.sessionId))
})

test('close → resume returns the closed session to ready (fake ledger semantics; harness 用 rebuildSession 显式重建)', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  await session.close()
  const resumed = await engine.resumeSession(session.sessionId)
  assert.equal(resumed.sessionId, session.sessionId)
  assert.equal((await engine.listSessions())[0]!.state, 'ready')
})

test('resume override replaces the working directory (fake ledger semantics)', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work/one' })
  const resumed = await engine.resumeSession(session.sessionId, { workingDirectory: '/work/three' })
  assert.equal(resumed.sessionId, session.sessionId)
  assert.equal(await resumed.getWorkingDirectory(), '/work/three')
  assert.equal((await engine.listSessions())[0]!.workingDirectory, '/work/three')
})

test('session.error ends the stream, marks failed, and requires explicit resume', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  engine.setSessionScript(session.sessionId, [
    { kind: 'session.error', error: { code: 'ENGINE_TIMEOUT', message: 'timed out', retryable: true } },
    { kind: 'message.complete', text: 'must not be reached' },
  ] as FakeScriptEvent[])

  const events = await collect(session.send('x'))
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, 'session.error')
  if (events[0]!.kind === 'session.error') assert.equal(events[0]!.error.code, 'ENGINE_TIMEOUT')
  assert.equal((await engine.listSessions())[0]!.state, 'failed')
  assert.throws(() => session.send('x'), isCode('TRANSPORT_CLOSED'))

  await engine.resumeSession(session.sessionId)
  assert.equal((await engine.listSessions())[0]!.state, 'ready')
})

test('session.closed ends the stream and marks the session closed', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  engine.setSessionScript(session.sessionId, [
    { kind: 'session.closed', reason: 'requested' },
  ] as FakeScriptEvent[])

  const events = await collect(session.send('x'))
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, 'session.closed')
  assert.equal((await engine.listSessions())[0]!.state, 'closed')
  assert.throws(() => session.send('x'), isCode('TRANSPORT_CLOSED'))
})

test('unmapped error maps to ENGINE_UNKNOWN with rawCode', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  const poison = {
    get kind(): never {
      throw Object.assign(new Error('boom'), { code: 'RAW_CODE_X' })
    },
  } as unknown as FakeScriptEvent
  engine.setSessionScript(session.sessionId, [poison])

  const events = await collect(session.send('x'))
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, 'session.error')
  if (events[0]!.kind === 'session.error') {
    assert.equal(events[0]!.error.code, 'ENGINE_UNKNOWN')
    assert.equal(events[0]!.error.rawCode, 'RAW_CODE_X')
    assert.equal(events[0]!.error.retryable, false)
  }
})
