import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TokenUsageLedger } from '../src/token-usage.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function ledger(onThreshold?: (record: unknown) => void): {
  usage: TokenUsageLedger
  file: string
  thresholds: unknown[]
} {
  const root = mkdtempSync(join(tmpdir(), 'token-usage-'))
  roots.push(root)
  const file = join(root, 'usage.jsonl')
  const thresholds: unknown[] = []
  const usage = new TokenUsageLedger({
    file,
    onThreshold: record => { thresholds.push(record); onThreshold?.(record) },
    now: () => 1_700_000_000_000,
  })
  return { usage, file, thresholds }
}

describe('token usage ledger', () => {
  it('accumulates multiple rounds per task and keeps tasks isolated', () => {
    const { usage } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
    })
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 2,
      usage: { inputTokens: 200, outputTokens: 40, cacheWriteTokens: 10 },
    })
    usage.ingest({
      projectId: 'p1', sessionId: 's2', taskId: 't2', round: 1,
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    const snapshot = usage.snapshot({ taskId: 't1' })
    expect(snapshot).toMatchObject({
      taskId: 't1', promptTokens: 300, cachedTokens: 40, completionTokens: 60, totalTokens: 400,
      cacheHitRatio: 40 / 300,
    })
    expect(snapshot.rounds).toEqual([
      { round: 1, promptTokens: 100, cachedTokens: 30, completionTokens: 20, totalTokens: 150 },
      { round: 2, promptTokens: 200, cachedTokens: 10, completionTokens: 40, totalTokens: 250 },
    ])
    expect(snapshot.recent).toHaveLength(2)
    expect(snapshot.top).toEqual([])
    expect(usage.snapshot({ taskId: 't2' }).totalTokens).toBe(10)
    expect(usage.snapshot({ sessionId: 's1' }).totalTokens).toBe(400)
  })

  it('falls back to zero when an event has no usage counters', () => {
    const { usage } = ledger()
    expect(usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 1, usage: {},
    })).toBeUndefined()
    expect(usage.snapshot({ taskId: 't1' })).toMatchObject({
      promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitRatio: 0, rounds: [],
    })
  })

  it('emits one threshold at 80% across rounds and persists without text', () => {
    const { usage, file, thresholds } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 1,
      usage: { inputTokens: 15_000, outputTokens: 1_000 },
    })
    expect(thresholds).toHaveLength(0)
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 2,
      usage: { inputTokens: 8_000, outputTokens: 1_000 },
    })
    expect(thresholds).toHaveLength(1)
    expect(thresholds[0]).toMatchObject({
      kind: 'threshold', taskId: 't1', tokens: 25_000, threshold: 'task-80%', action: 'compress+continue',
    })
    expect(usage.isPressured('t1')).toBe(true)
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 3,
      usage: { inputTokens: 1_000, outputTokens: 100 },
    })
    expect(thresholds).toHaveLength(1)
    const persisted = readFileSync(file, 'utf8')
    expect(persisted).toContain('"kind":"usage"')
    expect(persisted).toContain('"kind":"threshold"')
    expect(persisted).not.toContain('"body"')
    expect(persisted).not.toContain('"text"')
    expect(persisted).not.toContain('secret')
  })

  it('reloads persisted usage after a restart', () => {
    const { usage, file } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 's1', taskId: 't1', round: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    const restarted = new TokenUsageLedger({ file })
    expect(restarted.snapshot({ taskId: 't1' }).totalTokens).toBe(12)
    expect(restarted.snapshot({ sessionId: 's1' }).totalTokens).toBe(12)
  })
})
