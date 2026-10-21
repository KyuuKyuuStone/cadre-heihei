import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '../../src/collab/protocol/ids.ts'
import type { EngineEvent } from '../../src/ports/engine.ts'
import {
  mapHarnessError,
  mapHarnessEvents,
  type HarnessEventLike,
} from '../../src/adapters/engine/harness/mapping.ts'

const SESSION = 'session-test' as SessionId
const TIME = 1_700_000_000_000

function kinds(events: EngineEvent[]): string[] {
  return events.map((event) => event.kind)
}

function texts(events: EngineEvent[]): string[] {
  return events.map((event) =>
    event.kind === 'message.delta' || event.kind === 'message.complete' ? event.text : '')
}

test('assistant/message: stream text chunks -> delta + complete', () => {
  const events: HarnessEventLike[] = [{
    type: 'assistant/message',
    seq: 10,
    time: TIME,
    data: {
      message: { content: [{ type: 'text', text: 'Hello' }] },
      stream: [{ type: 'text-chunks', texts: ['Hel', 'lo'] }],
    },
  }]
  const result = mapHarnessEvents(events, { sessionId: SESSION })
  assert.deepEqual(kinds(result.events), ['message.delta', 'message.delta', 'message.complete'])
  assert.deepEqual(texts(result.events), ['Hel', 'lo', 'Hello'])
  assert.equal(result.events[0]!.sessionId, SESSION)
  assert.equal(result.events[0]!.at, new Date(TIME).toISOString())
  assert.deepEqual(result.diagnostics, [])
})

test('assistant/message: content text fallback when stream is absent', () => {
  const events: HarnessEventLike[] = [{
    type: 'assistant/message',
    time: TIME,
    data: { message: { content: [{ type: 'text', text: 'Hi' }] } },
  }]
  const result = mapHarnessEvents(events, { sessionId: SESSION })
  assert.deepEqual(kinds(result.events), ['message.delta', 'message.complete'])
  assert.deepEqual(texts(result.events), ['Hi', 'Hi'])
})

test('tool/call + tool/result: names, callId, ok and summary', () => {
  const events: HarnessEventLike[] = [
    {
      type: 'tool/call',
      time: TIME,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' },
    },
    {
      type: 'tool/result',
      time: TIME + 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          isError: false,
          content: [{ type: 'text', text: 'file contents' }],
        },
      },
    },
  ]
  const result = mapHarnessEvents(events, { sessionId: SESSION })
  assert.deepEqual(kinds(result.events), ['tool.call', 'tool.result'])
  const call = result.events[0]!
  const toolResult = result.events[1]!
  assert.equal(call.kind === 'tool.call' && call.toolName, 'read')
  assert.equal(call.kind === 'tool.call' && call.callId, 'call-1')
  assert.equal(toolResult.kind === 'tool.result' && toolResult.toolName, 'read')
  assert.equal(toolResult.kind === 'tool.result' && toolResult.ok, true)
  assert.equal(toolResult.kind === 'tool.result' && toolResult.summary, 'file contents')
})

test('tool/result: error flag and reason', () => {
  const events: HarnessEventLike[] = [{
    type: 'tool/result',
    time: TIME,
    data: {
      message: { toolCallId: 'call-x', isError: true, content: [] },
      error: { name: 'ToolError', code: 'E_TOOL', reason: 'permission denied' },
    },
  }]
  const result = mapHarnessEvents(events, { sessionId: SESSION })
  const event = result.events[0]!
  assert.equal(event.kind, 'tool.result')
  if (event.kind === 'tool.result') {
    assert.equal(event.ok, false)
    assert.equal(event.toolName, 'tool')
    assert.equal(event.summary, 'permission denied')
  }
})

test('compaction/start|summary|end -> port events with raw data', () => {
  const start = { compactionId: 'c1', turn: 2 }
  const summary = { compactionId: 'c1', turn: 2, summary: [{ type: 'text', text: 's' }] }
  const end = { compactionId: 'c1', turn: 2 }
  const events: HarnessEventLike[] = [
    { type: 'compaction/start', time: TIME, data: start },
    { type: 'compaction/summary', time: TIME + 1, data: summary },
    { type: 'compaction/end', time: TIME + 2, data: end },
  ]
  const result = mapHarnessEvents(events, { sessionId: SESSION })
  assert.deepEqual(kinds(result.events), ['compaction.start', 'compaction.summary', 'compaction.end'])
  assert.deepEqual(result.events.map((event) => event.kind === 'compaction.start' ? event.raw : undefined), [start, undefined, undefined])
})

test('unknown event -> diagnostic, never a success event', () => {
  const result = mapHarnessEvents([
    { type: 'plugin/unknown', seq: 42, time: TIME, data: { secret: 'do-not-map' } },
  ], { sessionId: SESSION })
  assert.deepEqual(result.events, [])
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0]!.kind, 'unknown-event')
  assert.equal(result.diagnostics[0]!.eventType, 'plugin/unknown')
  assert.equal(result.diagnostics[0]!.seq, 42)
})

test('known lifecycle event -> intentionally ignored (no diagnostic)', () => {
  const result = mapHarnessEvents([
    { type: 'turn/start', time: TIME, data: { turn: 1 } },
    { type: 'request/header', time: TIME, data: { header: {} } },
  ], { sessionId: SESSION })
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.diagnostics, [])
})

test('assistant/attempt -> diagnostic, not success', () => {
  const result = mapHarnessEvents([
    { type: 'assistant/attempt', seq: 3, time: TIME, data: { stream: [] } },
  ], { sessionId: SESSION })
  assert.deepEqual(result.events, [])
  assert.equal(result.diagnostics[0]!.kind, 'assistant-attempt')
})

test('synthetic session.error and session.closed map to port events', () => {
  const result = mapHarnessEvents([
    {
      type: 'session.error',
      time: TIME,
      data: { error: { code: 'ENGINE_PROTOCOL', message: 'bad frame', retryable: false } },
    },
    { type: 'session.closed', time: TIME + 1, data: { reason: 'crashed' } },
  ], { sessionId: SESSION })
  assert.deepEqual(kinds(result.events), ['session.error', 'session.closed'])
  const error = result.events[0]!
  assert.equal(error.kind === 'session.error' && error.error.code, 'ENGINE_PROTOCOL')
  const closed = result.events[1]!
  assert.equal(closed.kind === 'session.closed' && closed.reason, 'crashed')
})

test('mapHarnessError: typed harness failures and unmapped rawCode', () => {
  const transport = mapHarnessError({ name: 'TransportClosedError', message: 'gone', code: 7 }, 'send')
  assert.equal(transport.code, 'TRANSPORT_CLOSED')
  assert.equal(transport.retryable, false)
  assert.equal(transport.rawCode, '7')

  const timeout = mapHarnessError({ name: 'RequestTimeoutError', message: 'slow' }, 'send')
  assert.equal(timeout.code, 'ENGINE_TIMEOUT')
  assert.equal(timeout.retryable, true)

  const protocol = mapHarnessError({ name: 'JsonRpcResponseError', message: 'no method', code: -32601 }, 'send')
  assert.equal(protocol.code, 'ENGINE_PROTOCOL')
  assert.equal(protocol.rawCode, '-32601')

  const unknown = mapHarnessError(Object.assign(new Error('boom'), { code: 'RAW_CODE_X' }), 'send')
  assert.equal(unknown.code, 'ENGINE_UNKNOWN')
  assert.equal(unknown.retryable, false)
  assert.equal(unknown.rawCode, 'RAW_CODE_X')
})
