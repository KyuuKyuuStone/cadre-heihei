import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('accumulates disjoint provider buckets per task and keeps tasks isolated', () => {
    const { usage } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
    })
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 2,
      usage: { inputTokens: 200, outputTokens: 40, cacheWriteTokens: 10 },
    })
    usage.ingest({
      projectId: 'p1', sessionId: 's2', role: 'worker', taskId: 't2', round: 1,
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    const snapshot = usage.snapshot({ taskId: 't1' })
    expect(snapshot).toMatchObject({
      taskId: 't1', role: 'worker',
      uncachedInput: 300, cacheRead: 30, cacheWrite: 10, output: 60,
      promptTokens: 300, cachedTokens: 40, completionTokens: 60, totalTokens: 400,
      rawUsageComplete: true, cacheHitRatio: 30 / 340,
    })
    expect(snapshot.rounds).toEqual([
      {
        round: 1, uncachedInput: 100, cacheRead: 30, cacheWrite: 0, output: 20,
        compacted: false, compactionCount: 0,
        promptTokens: 100, cachedTokens: 30, completionTokens: 20, totalTokens: 150,
      },
      {
        round: 2, uncachedInput: 200, cacheRead: 0, cacheWrite: 10, output: 40,
        compacted: false, compactionCount: 0,
        promptTokens: 200, cachedTokens: 10, completionTokens: 40, totalTokens: 250,
      },
    ])
    expect(snapshot.recent).toHaveLength(2)
    expect(snapshot.top).toEqual([])
    expect(usage.snapshot({ taskId: 't2' }).totalTokens).toBe(10)
    expect(usage.snapshot({ sessionId: 's1' })).toMatchObject({
      role: 'worker', totalTokens: 400, uncachedInput: 300, cacheRead: 30, cacheWrite: 10, output: 60,
    })
    expect(usage.snapshot({ sessionId: 's1' }).rounds).toHaveLength(2)
  })

  it('pins the full 02 Session totals and corrected cache-hit ratio', async () => {
    const { usage } = ledger()
    usage.ingest({
      projectId: 'p02', sessionId: 'session-315687fa-195a-4d81-bac9-b5b5978f8ad9',
      role: 'supervisor', round: 1,
      usage: {
        inputTokens: 5_613, cacheReadTokens: 238_720, cacheWriteTokens: 0,
        outputTokens: 20_909, totalTokens: 265_242,
      },
    })
    const snapshot = usage.snapshot({ sessionId: 'session-315687fa-195a-4d81-bac9-b5b5978f8ad9' })
    expect(snapshot.cacheHitRatio).toBeCloseTo(0.977, 3)
    await expect(snapshot).toMatchFileSnapshot('__file_snapshots__/token-usage-02.json')
  })

  it('attributes completed compactions by session, role, task and owning turn', () => {
    const { usage, file } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 'w1', role: 'worker', taskId: 't1', round: 1,
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    usage.ingest({
      projectId: 'p1', sessionId: 'w1', role: 'worker', taskId: 't1', round: 2,
      usage: { inputTokens: 200, outputTokens: 40 },
    })
    usage.ingestCompaction({ projectId: 'p1', sessionId: 'w1', role: 'worker', taskId: 't1', round: 1 })
    usage.ingestCompaction({ projectId: 'p1', sessionId: 'w1', role: 'worker', taskId: 't1', round: null })
    usage.ingestCompaction({
      projectId: 'p1', sessionId: 'w1', role: 'worker', taskId: 't1', round: 2, error: 'cancelled',
    })
    const snapshot = usage.snapshot({ taskId: 't1', sessionId: 'w1' })
    expect(snapshot).toMatchObject({
      sessionId: 'w1', role: 'worker', compactionCount: 2, unattributedCompactions: 1,
    })
    expect(snapshot.rounds).toMatchObject([
      { round: 1, compacted: true, compactionCount: 1 },
      { round: 2, compacted: false, compactionCount: 0 },
    ])
    expect(usage.snapshot({ sessionId: 'w1' })).toMatchObject({
      role: 'worker', compactionCount: 2, unattributedCompactions: 1,
    })
    const persisted = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string })
    expect(persisted.filter(record => record.kind === 'compaction')).toHaveLength(3)
    const restarted = new TokenUsageLedger({ file })
    expect(restarted.snapshot({ taskId: 't1', sessionId: 'w1' })).toEqual(snapshot)
  })

  it('preserves compaction attribution when the end event precedes later usage in its turn', () => {
    const { usage } = ledger()
    usage.ingestCompaction({ projectId: 'p1', sessionId: 's1', role: 'supervisor', round: 3 })
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'supervisor', round: 3,
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    expect(usage.snapshot({ sessionId: 's1' })).toMatchObject({
      compactionCount: 1, rounds: [{ round: 3, compacted: true, compactionCount: 1, totalTokens: 12 }],
    })
  })

  it('keeps legacy totals without inventing an exact cache-read/write split', () => {
    const { file } = ledger()
    writeFileSync(file, `${JSON.stringify({
      kind: 'usage', at: '2026-11-06T00:00:00.000Z', projectId: 'p1', sessionId: 's1',
      taskId: 't1', round: 1, promptTokens: 100, cachedTokens: 40,
      completionTokens: 20, totalTokens: 160,
    })}\n`, 'utf8')
    const restarted = new TokenUsageLedger({ file })
    expect(restarted.snapshot({ taskId: 't1' })).toMatchObject({
      promptTokens: 100, cachedTokens: 40, completionTokens: 20, totalTokens: 160,
      uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0,
      rawUsageComplete: false, cacheHitRatio: 0,
    })
  })

  it('falls back to zero when an event has no usage counters', () => {
    const { usage } = ledger()
    expect(usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 1, usage: {},
    })).toBeUndefined()
    expect(usage.snapshot({ taskId: 't1' })).toMatchObject({
      promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitRatio: 0, rounds: [],
    })
  })

  it('emits one threshold at 80% across rounds and persists without text', () => {
    const { usage, file, thresholds } = ledger()
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 1,
      usage: { inputTokens: 15_000, outputTokens: 1_000 },
    })
    expect(thresholds).toHaveLength(0)
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 2,
      usage: { inputTokens: 8_000, outputTokens: 1_000 },
    })
    expect(thresholds).toHaveLength(1)
    expect(thresholds[0]).toMatchObject({
      kind: 'threshold', taskId: 't1', tokens: 25_000, threshold: 'task-80%', action: 'compress+continue',
    })
    expect(usage.isPressured('t1')).toBe(true)
    usage.ingest({
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 3,
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
      projectId: 'p1', sessionId: 's1', role: 'worker', taskId: 't1', round: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    const restarted = new TokenUsageLedger({ file })
    expect(restarted.snapshot({ taskId: 't1' })).toMatchObject({
      totalTokens: 12, uncachedInput: 10, output: 2, rawUsageComplete: true,
    })
    expect(restarted.snapshot({ sessionId: 's1' }).totalTokens).toBe(12)
  })
})
