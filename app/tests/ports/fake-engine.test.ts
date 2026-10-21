import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '../../src/collab/protocol/ids.ts'
import { FakeEngine, type FakeScriptEvent } from '../../src/adapters/engine/fake/index.ts'
import type { EngineError, EngineEvent } from '../../src/ports/engine.ts'

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

function texts(events: EngineEvent[]): string[] {
  return events.map((event) =>
    event.kind === 'message.delta' || event.kind === 'message.complete' ? event.text : event.kind)
}

test('lifecycle: start → create → send → stop', async () => {
  const engine = new FakeEngine()
  assert.equal(engine.engineId, 'fake')
  assert.equal((await engine.health()).state, 'unknown')
  assert.deepEqual(await engine.listSessions(), [])

  await engine.start()
  assert.equal((await engine.health()).state, 'ready')

  const session = await engine.createSession({ workingDirectory: '/work/a', title: 'a' })
  assert.ok(session.sessionId.length > 0)
  assert.ok(session.runtimeId.length > 0)

  const events = await collect(session.send('hello'))
  assert.deepEqual(events.map((event) => event.kind), ['message.delta', 'message.complete'])
  assert.deepEqual(texts(events), ['fake:hello', 'fake:hello'])
  assert.ok(events.every((event) => event.sessionId === session.sessionId))
  assert.ok(events.every((event) => typeof event.at === 'string' && event.at.length > 0))

  const listed = await engine.listSessions()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.state, 'ready')
  assert.equal(listed[0]!.workingDirectory, '/work/a')

  await session.close()
  assert.equal((await engine.listSessions())[0]!.state, 'closed')

  await engine.stop()
  assert.equal((await engine.health()).state, 'stopped')
  assert.equal((await engine.listSessions())[0]!.state, 'closed')
  await assert.rejects(engine.start(), isCode('ENGINE_UNAVAILABLE'))
})

test('two sessions: distinct runtimes and no event sessionId crosstalk', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const a = await engine.createSession({ workingDirectory: '/work/a' })
  const b = await engine.createSession({ workingDirectory: '/work/b' })

  assert.notEqual(a.sessionId, b.sessionId)
  assert.notEqual(a.runtimeId, b.runtimeId)

  engine.setSessionScript(a.sessionId, [
    { kind: 'message.delta', text: 'A1' },
    { kind: 'message.complete', text: 'A2' },
  ] as FakeScriptEvent[])
  engine.setSessionScript(b.sessionId, [
    { kind: 'message.delta', text: 'B1' },
    { kind: 'message.complete', text: 'B2' },
  ] as FakeScriptEvent[])

  const [eventsA, eventsB] = await Promise.all([collect(a.send('x')), collect(b.send('y'))])
  assert.ok(eventsA.every((event) => event.sessionId === a.sessionId))
  assert.ok(eventsB.every((event) => event.sessionId === b.sessionId))
  assert.deepEqual(texts(eventsA), ['A1', 'A2'])
  assert.deepEqual(texts(eventsB), ['B1', 'B2'])
})

test('workingDirectory roundtrip and resume override', async () => {
  const engine = new FakeEngine()
  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work/one' })
  assert.equal(await session.getWorkingDirectory(), '/work/one')

  await session.setWorkingDirectory('/work/two')
  assert.equal(await session.getWorkingDirectory(), '/work/two')

  const resumed = await engine.resumeSession(session.sessionId, { workingDirectory: '/work/three' })
  assert.equal(resumed.sessionId, session.sessionId)
  assert.equal(resumed.runtimeId, session.runtimeId)
  assert.equal(await resumed.getWorkingDirectory(), '/work/three')
  assert.equal((await engine.listSessions())[0]!.workingDirectory, '/work/three')
})

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

test('not-started and stopped operations return TRANSPORT_CLOSED', async () => {
  const engine = new FakeEngine()
  await assert.rejects(engine.createSession({ workingDirectory: '/work' }), isCode('TRANSPORT_CLOSED'))
  await assert.rejects(engine.resumeSession('missing' as SessionId), isCode('TRANSPORT_CLOSED'))

  await engine.start()
  const session = await engine.createSession({ workingDirectory: '/work' })
  await engine.stop()

  assert.throws(() => session.send('x'), isCode('TRANSPORT_CLOSED'))
  await assert.rejects(session.setWorkingDirectory('/other'), isCode('TRANSPORT_CLOSED'))
  await assert.rejects(engine.createSession({ workingDirectory: '/work' }), isCode('TRANSPORT_CLOSED'))
  await assert.rejects(engine.resumeSession(session.sessionId), isCode('TRANSPORT_CLOSED'))
})

test('capabilities match harness evidence exactly', () => {
  const engine = new FakeEngine()
  assert.deepEqual(engine.capabilities(), {
    manualCompact: false,
    tokenUsage: false,
    mcpTools: true,
    compactionEvents: 'available',
    sessionEnumeration: false,
    crashRecovery: 'structured-error-only',
  })
  // A1 v2 判据层通过：能力位与实测一致，且不得扩张为 system 注入可用。
  assert.equal(engine.capabilities().compactionEvents, 'available')
})

test('resume only restores ledger sessions; missing -> ENGINE_UNAVAILABLE', async () => {
  const engine = new FakeEngine()
  await engine.start()
  await assert.rejects(
    engine.resumeSession('does-not-exist' as SessionId),
    (error: unknown) => isCode('ENGINE_UNAVAILABLE')(error) && (error as EngineError).retryable === false,
  )

  const session = await engine.createSession({ workingDirectory: '/work' })
  await session.close()
  const resumed = await engine.resumeSession(session.sessionId)
  assert.equal(resumed.sessionId, session.sessionId)
  assert.equal((await engine.listSessions())[0]!.state, 'ready')
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
