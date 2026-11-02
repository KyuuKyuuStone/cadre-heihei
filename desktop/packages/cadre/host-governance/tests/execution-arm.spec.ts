import { describe, expect, it } from 'vitest'
import { EXECUTION_ARM_TTL_MS, ExecutionArm } from '../src/execution-arm.ts'

function clock(): {
  arm: ExecutionArm
  audits: unknown[]
  advance(ms: number): void
} {
  let now = 0
  const audits: unknown[] = []
  const arm = new ExecutionArm({
    now: () => now,
    audit: record => { audits.push(record) },
  })
  return { arm, audits, advance: ms => { now += ms } }
}

describe('execution arm', () => {
  it('defaults to discussion, arms on demand, and is consumed by one dispatch', () => {
    const { arm, audits } = clock()
    expect(arm.status('p1')).toBeUndefined()
    expect(arm.arm('p1', 's1')).toMatchObject({ projectId: 'p1', sessionId: 's1', armed: true, mode: 'single-batch' })
    expect(arm.status('p1')?.armed).toBe(true)
    expect(arm.consume('p1')).toBe(true)
    expect(arm.status('p1')).toBeUndefined()
    expect(arm.consume('p1')).toBe(false)
    expect(audits).toMatchObject([
      { action: 'arm', projectId: 'p1', sessionId: 's1' },
      { action: 'consume', projectId: 'p1', sessionId: 's1' },
    ])
  })

  it('expires after the TTL and records the expiry', () => {
    const { arm, audits, advance } = clock()
    arm.arm('p1', 's1', 'ttl')
    advance(EXECUTION_ARM_TTL_MS - 1)
    expect(arm.status('p1')).toBeDefined()
    advance(1)
    expect(arm.status('p1')).toBeUndefined()
    expect(audits.at(-1)).toMatchObject({ action: 'expire', projectId: 'p1' })
  })
})
