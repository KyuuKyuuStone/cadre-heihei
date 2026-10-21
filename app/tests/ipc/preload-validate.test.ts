/** preload 白名单校验器：JSON 类型矩阵、身份字段与 1MB 上限。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isJsonLikeValue,
  validateIpcInput,
} from '../../src/preload/validate.ts'
import { IPC_MAX_PAYLOAD_BYTES } from '../../src/shared/ipc.ts'

class ExampleClass {
  readonly value = 1
}

function expectInvalid(result: ReturnType<typeof validateIpcInput>, field?: string): void {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'INVALID_ARGUMENT')
  assert.equal(result.error.retryable, false)
  if (field !== undefined) assert.equal(result.error.field, field)
}

test('JSON 类型矩阵：允许 JSON 类值，拒绝函数/Symbol/BigInt/Date/Map/Set/类实例', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const valid: Array<[string, unknown]> = [
    ['string', 'text'],
    ['number', 1.5],
    ['boolean', false],
    ['null', null],
    ['array', [1, 'two', null, { three: true }]],
    ['plain object', { a: 1, nested: { b: [true] } }],
    ['null-prototype object', Object.assign(Object.create(null), { a: 1 })],
  ]
  for (const [label, value] of valid) {
    assert.equal(isJsonLikeValue(value), true, `应允许 ${label}`)
  }

  const invalid: Array<[string, unknown]> = [
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['bigint', 1n],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date()],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['RegExp', /x/],
    ['class instance', new ExampleClass()],
    ['cyclic', cyclic],
    ['sparse array', [1, , 3]],
    ['symbol key', { [Symbol('k')]: 1 }],
  ]
  for (const [label, value] of invalid) {
    assert.equal(isJsonLikeValue(value), false, `应拒绝 ${label}`)
  }
})

test('校验器：listTasks 接受对象/省略，拒绝顶层数组与嵌套非法值', () => {
  const ok = validateIpcInput('collab:listTasks', {
    status: ['review', 'delivered'],
    limit: 10,
    since: { updatedAt: '2026-10-21T00:00:00.000Z', seq: 2 },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok ? ok.value : undefined, {
    status: ['review', 'delivered'],
    limit: 10,
    since: { updatedAt: '2026-10-21T00:00:00.000Z', seq: 2 },
  })

  const omitted = validateIpcInput('collab:listTasks', undefined)
  assert.equal(omitted.ok, true)
  assert.deepEqual(omitted.ok ? omitted.value : undefined, {})

  expectInvalid(validateIpcInput('collab:listTasks', [1, 2]), 'input')
  expectInvalid(validateIpcInput('collab:listTasks', { nested: { fn: () => 1 } }), 'input.nested.fn')
  expectInvalid(validateIpcInput('collab:listTasks', { nested: new Map() }), 'input.nested')
  expectInvalid(validateIpcInput('collab:listTasks', { ok: undefined }), 'input.ok')
})

test('身份覆盖：projectId/sessionId 出现即拒绝', () => {
  expectInvalid(validateIpcInput('collab:listTasks', { projectId: 'p2' }), 'projectId')
  expectInvalid(validateIpcInput('collab:listTasks', { sessionId: 'other' }), 'sessionId')
  expectInvalid(validateIpcInput('app:whoami', { projectId: 'p2' }), 'projectId')
  // 值即使 undefined 也不得出现。
  expectInvalid(validateIpcInput('collab:listTasks', { sessionId: undefined }), 'sessionId')
  expectInvalid(validateIpcInput('collab:dispatchTask', { sessionId: 's' }), 'sessionId')
  expectInvalid(validateIpcInput('session:unsubscribe', { sessionId: 's' }), 'sessionId')
})

test('会话通道允许目标 sessionId，但仍拒绝 projectId/channel', () => {
  const send = validateIpcInput('session:send', {
    sessionId: 'session-emp',
    body: 'hi',
    idempotencyKey: 'k',
  })
  assert.equal(send.ok, true)
  const subscribe = validateIpcInput('session:subscribe', { sessionId: 'session-emp' })
  assert.equal(subscribe.ok, true)

  expectInvalid(
    validateIpcInput('session:send', { projectId: 'p', sessionId: 's', body: 'hi' }),
    'projectId',
  )
  expectInvalid(
    validateIpcInput('session:send', { channel: 'session:event', sessionId: 's', body: 'hi' }),
    'channel',
  )
  expectInvalid(validateIpcInput('session:send', { sessionId: 's', body: () => 1 }), 'input.body')
})

test('无参通道与未知通道', () => {
  const whoami = validateIpcInput('app:whoami', undefined)
  assert.equal(whoami.ok, true)
  assert.equal(whoami.ok ? whoami.value : 'x', undefined)

  const prefs = validateIpcInput('prefs:get', null)
  assert.equal(prefs.ok, true)

  expectInvalid(validateIpcInput('unknown:channel', {}), 'channel')
})

test('请求体上限 1MB', () => {
  const within = validateIpcInput('collab:listTasks', { note: 'x'.repeat(IPC_MAX_PAYLOAD_BYTES - 100) })
  assert.equal(within.ok, true)
  const over = validateIpcInput('collab:listTasks', {
    note: 'x'.repeat(IPC_MAX_PAYLOAD_BYTES + 10),
  })
  expectInvalid(over, 'payload')
})
