import type { IdempotencyKey } from '../../collab/protocol/ids.ts'

/**
 * 调用方生成幂等键；同一次表单重试必须复用，成功后换新。
 * 无 randomUUID 时用 getRandomValues（128bit）；两者都不可用时抛错，
 * 绝不静默退化为弱随机（幂等键碰撞会导致重复派活/汇报）。
 */
export function newIdempotencyKey(): IdempotencyKey {
  const cryptoObject = globalThis.crypto
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID() as IdempotencyKey
  }
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoObject.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') as IdempotencyKey
  }
  throw new Error('crypto unavailable: cannot generate a strong idempotency key')
}
