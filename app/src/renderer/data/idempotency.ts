import type { IdempotencyKey } from '../../collab/protocol/ids.ts'

/** 调用方生成幂等键；同一次表单重试必须复用，成功后换新。 */
export function newIdempotencyKey(): IdempotencyKey {
  const cryptoObject = globalThis.crypto
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID() as IdempotencyKey
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` as IdempotencyKey
}
