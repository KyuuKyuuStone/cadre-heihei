import { afterEach, describe, expect, it, vi } from 'vitest'
import { newIdempotencyKey } from '../../../src/renderer/data/idempotency.ts'

describe('幂等键生成', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('优先使用 randomUUID', () => {
    const randomUUID = vi.fn(() => '11111111-2222-3333-4444-555555555555')
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() })
    expect(newIdempotencyKey()).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('无 randomUUID 时用 getRandomValues 生成 128bit 十六进制', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xab)
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })

    const key = newIdempotencyKey()

    expect(getRandomValues).toHaveBeenCalledTimes(1)
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16)
    expect(key).toBe('ab'.repeat(16))
  })

  it('crypto 不可用时抛错，不静默弱随机', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => newIdempotencyKey()).toThrow(/crypto unavailable/)
  })
})
