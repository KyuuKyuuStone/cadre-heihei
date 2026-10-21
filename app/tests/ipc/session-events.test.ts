/** 事件泵：delta 合并、立即 flush、seq/epoch、订阅清理、raw 剥离。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EngineEvent } from '../../src/ports/engine.ts'
import {
  SESSION_EVENT_CHANNEL,
  SessionEventPump,
} from '../../src/main/session-events.ts'
import type { SessionEvent } from '../../src/shared/ipc.ts'
import type { SessionId } from '../../src/collab/protocol/index.ts'

const EMP = 'session-emp' as SessionId
const AT = '2026-10-21T00:00:00.000Z' as never

interface Captured {
  readonly windowId: string
  readonly channel: string
  readonly event: SessionEvent
}

function makePump(throttle = 16, bufferLimit?: number) {
  const captured: Captured[] = []
  const pump = new SessionEventPump({
    sink: (windowId, channel, event) => captured.push({ windowId, channel, event }),
    deltaThrottleMs: throttle,
    ...(bufferLimit === undefined ? {} : { bufferLimit }),
  })
  return { pump, captured }
}

function delta(text: string): EngineEvent {
  return { kind: 'message.delta', sessionId: EMP, at: AT, text }
}
function complete(text: string): EngineEvent {
  return { kind: 'message.complete', sessionId: EMP, at: AT, text }
}

test('订阅去重：同窗口同会话返回同一 subscriptionId', () => {
  const { pump } = makePump()
  try {
    const first = pump.subscribe('win-1', EMP)
    const second = pump.subscribe('win-1', EMP)
    assert.equal(first.subscriptionId, second.subscriptionId)
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    const otherWindow = pump.subscribe('win-2', EMP)
    assert.notEqual(otherWindow.subscriptionId, first.subscriptionId)
  } finally {
    pump.dispose()
  }
})

test('delta 16ms 合并；complete 立即 flush 且顺序正确', () => {
  const { pump, captured } = makePump(16)
  try {
    pump.subscribe('win-1', EMP)
    pump.push(delta('a'))
    pump.push(delta('b'))
    assert.equal(captured.length, 0, '合并窗口内不应发送')
    pump.flush()
    assert.equal(captured.length, 1)
    const merged = captured[0]!.event
    assert.equal(merged.kind, 'message.delta')
    assert.equal(merged.kind === 'message.delta' ? merged.text : '', 'ab')
    // 合并事件使用批内最后一条 delta 的 seq（a=1, b=2）。
    assert.equal(merged.seq, 2)
    assert.equal(merged.epoch, 1)

    pump.push(delta('c'))
    pump.push(complete('abc'))
    assert.equal(captured.length, 3)
    assert.deepEqual(
      captured.slice(1).map((entry) => entry.event.kind),
      ['message.delta', 'message.complete'],
    )
    // c=3（合并事件），complete=4；跳号 2→3→4 表示 delta 合并。
    assert.deepEqual(
      captured.map((entry) => entry.event.seq),
      [2, 3, 4],
    )
    assert.equal(captured[1]!.event.kind === 'message.delta' ? captured[1]!.event.text : '', 'c')
    assert.equal(captured[2]!.event.kind === 'message.complete' ? captured[2]!.event.text : '', 'abc')
    assert.ok(captured.every((entry) => entry.channel === SESSION_EVENT_CHANNEL))
  } finally {
    pump.dispose()
  }
})

test('seq 单调；bumpEpoch 后 epoch+1、seq 从 1 重新计数', () => {
  const { pump, captured } = makePump()
  try {
    pump.subscribe('win-1', EMP)
    pump.push(complete('one'))
    pump.push(complete('two'))
    assert.deepEqual(captured.map((entry) => [entry.event.seq, entry.event.epoch]), [
      [1, 1],
      [2, 1],
    ])
    const epoch = pump.bumpEpoch(EMP)
    assert.equal(epoch, 2)
    pump.push(complete('three'))
    const last = captured.at(-1)!.event
    assert.equal(last.seq, 1)
    assert.equal(last.epoch, 2)
  } finally {
    pump.dispose()
  }
})

test('投影不含 raw：compaction/error/closed 字段白名单', () => {
  const { pump, captured } = makePump()
  try {
    pump.subscribe('win-1', EMP)
    const raw = { data: { compactionId: 'c1', secret: 'do-not-leak' }, secret: 'do-not-leak' }
    pump.push({ kind: 'compaction.summary', sessionId: EMP, at: AT, raw })
    pump.push({
      kind: 'session.error',
      sessionId: EMP,
      at: AT,
      error: { code: 'ENGINE_TIMEOUT', message: 'timeout', retryable: true, rawCode: 'E_TIME' },
    })
    pump.push({ kind: 'session.closed', sessionId: EMP, at: AT, reason: 'crashed' })
    assert.equal(captured.length, 3)
    for (const entry of captured) {
      assert.equal('raw' in entry.event, false)
      assert.equal(JSON.stringify(entry.event).includes('do-not-leak'), false)
    }
    const errorEvent = captured[1]!.event
    assert.equal(errorEvent.kind, 'session.error')
    if (errorEvent.kind === 'session.error') {
      assert.deepEqual(errorEvent.error, {
        code: 'ENGINE_TIMEOUT',
        message: 'timeout',
        rawCode: 'E_TIME',
        retryable: true,
      })
    }
  } finally {
    pump.dispose()
  }
})

test('取消订阅/窗口销毁后停止投递', () => {
  const { pump, captured } = makePump()
  try {
    const win1 = pump.subscribe('win-1', EMP)
    const win2 = pump.subscribe('win-2', EMP)
    pump.push(complete('one'))
    assert.equal(captured.length, 2)

    assert.equal(pump.unsubscribe('win-1', win1.subscriptionId), true)
    pump.push(complete('two'))
    assert.equal(captured.length, 3)
    assert.equal(captured.at(-1)!.windowId, 'win-2')

    // lastSeq=2：抑制缓冲重放，仅验证“新订阅不会收到旧事件”。
    pump.subscribe('win-3', EMP, 2)
    pump.dropWindow('win-2')
    pump.dropWindow('win-3')
    pump.push(complete('three'))
    assert.equal(captured.length, 3, '无订阅者时不应实时投递')
    assert.equal(pump.unsubscribe('win-1', win2.subscriptionId), false, '不能取消别人的订阅')
  } finally {
    pump.dispose()
  }
})

function errorEvent(): EngineEvent {
  return {
    kind: 'session.error',
    sessionId: EMP,
    at: AT,
    error: { code: 'ENGINE_TIMEOUT', message: 'timeout', retryable: true },
  }
}

function closedEvent(): EngineEvent {
  return { kind: 'session.closed', sessionId: EMP, at: AT, reason: 'crashed' }
}

function toolResult(index: number): EngineEvent {
  return {
    kind: 'tool.result',
    sessionId: EMP,
    at: AT,
    toolName: 'tool',
    callId: `call-${index}`,
    ok: true,
    summary: `ok-${index}`,
  }
}

test('无订阅期终态事件不丢：lastSeq 补发全部缓冲且 seq 单调', () => {
  const { pump, captured } = makePump()
  try {
    pump.push(delta('a'))
    pump.flush()
    pump.push(complete('ab'))
    pump.push(errorEvent())
    pump.push(closedEvent())
    assert.equal(captured.length, 0, '无订阅者时不得实时投递')

    pump.subscribe('win-1', EMP, 0)
    assert.deepEqual(
      captured.map((entry) => entry.event.kind),
      ['message.delta', 'message.complete', 'session.error', 'session.closed'],
    )
    assert.deepEqual(
      captured.map((entry) => entry.event.seq),
      [1, 2, 3, 4],
    )
    assert.ok(captured.every((entry) => entry.channel === SESSION_EVENT_CHANNEL))
  } finally {
    pump.dispose()
  }
})

test('未给 lastSeq：只补发终态事件（保证 reload 后 UI 收敛）', () => {
  const { pump, captured } = makePump()
  try {
    pump.push(delta('a'))
    pump.flush()
    pump.push(complete('ab'))
    pump.push(errorEvent())
    pump.push(closedEvent())

    pump.subscribe('win-1', EMP)
    assert.deepEqual(
      captured.map((entry) => entry.event.kind),
      ['message.complete', 'session.error', 'session.closed'],
    )
  } finally {
    pump.dispose()
  }
})

test('lastSeq 补发只发 seq 之后的事件', () => {
  const { pump, captured } = makePump()
  try {
    pump.push(complete('one'))
    pump.push(complete('two'))
    pump.push(complete('three'))
    pump.subscribe('win-1', EMP, 1)
    assert.deepEqual(
      captured.map((entry) => [entry.event.kind, entry.event.seq]),
      [
        ['message.complete', 2],
        ['message.complete', 3],
      ],
    )
  } finally {
    pump.dispose()
  }
})

test('缓冲上限 256：淘汰最旧非终态，终态不被淘汰', () => {
  const { pump, captured } = makePump(16, 256)
  try {
    for (let index = 0; index < 300; index += 1) pump.push(toolResult(index))
    pump.push(complete('end'))
    pump.subscribe('win-1', EMP, 0)
    assert.equal(captured.length, 256)
    assert.equal(captured[0]!.event.seq, 46, '前 45 条非终态被淘汰')
    assert.equal(captured.at(-1)!.event.kind, 'message.complete')
    assert.equal(captured.at(-1)!.event.seq, 301)
    for (let index = 1; index < captured.length; index += 1) {
      assert.ok(captured[index]!.event.seq > captured[index - 1]!.event.seq)
    }
  } finally {
    pump.dispose()
  }
})

test('重建 epoch：清空旧缓冲，seq 从 1 重新计数', () => {
  const { pump, captured } = makePump()
  try {
    pump.push(complete('old'))
    assert.equal(pump.bumpEpoch(EMP), 2)
    pump.push(complete('new'))
    pump.subscribe('win-1', EMP, 0)
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.event.kind, 'message.complete')
    assert.equal(captured[0]!.event.seq, 1)
    assert.equal(captured[0]!.event.epoch, 2)
    assert.equal(
      captured[0]!.event.kind === 'message.complete' ? captured[0]!.event.text : '',
      'new',
    )
  } finally {
    pump.dispose()
  }
})
