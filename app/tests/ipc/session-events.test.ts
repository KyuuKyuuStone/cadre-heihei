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

function makePump(throttle = 16) {
  const captured: Captured[] = []
  const pump = new SessionEventPump({
    sink: (windowId, channel, event) => captured.push({ windowId, channel, event }),
    deltaThrottleMs: throttle,
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
    assert.equal(merged.seq, 1)
    assert.equal(merged.epoch, 1)

    pump.push(delta('c'))
    pump.push(complete('abc'))
    assert.equal(captured.length, 3)
    assert.deepEqual(
      captured.slice(1).map((entry) => entry.event.kind),
      ['message.delta', 'message.complete'],
    )
    assert.deepEqual(
      captured.map((entry) => entry.event.seq),
      [1, 2, 3],
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

    pump.subscribe('win-3', EMP)
    pump.dropWindow('win-2')
    pump.dropWindow('win-3')
    pump.push(complete('three'))
    assert.equal(captured.length, 3, '无订阅者时不应投递')
    assert.equal(pump.unsubscribe('win-1', win2.subscriptionId), false, '不能取消别人的订阅')
  } finally {
    pump.dispose()
  }
})
