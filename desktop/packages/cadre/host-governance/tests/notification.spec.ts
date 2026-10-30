import { describe, expect, it } from 'vitest'
import { notificationText } from '../src/service.ts'
import type { StallTaskView } from '../src/types.ts'

const VIEW: StallTaskView = {
  taskId: 't1', title: '修复登录', taskStatus: 'in_progress',
  assigneeSessionId: 'w1', assigneeName: '小明', assigneeRole: 'worker',
  lastActivityAt: Date.UTC(2026, 9, 29, 12, 0, 0), lastActivityKind: 'assistant',
  silenceMs: 600_000, stallState: 'stalled', stateSince: Date.UTC(2026, 9, 29, 12, 0, 0),
  episodeId: 't1:episode', nudgeCount: 1, lastNudgedAt: null, suggestedAction: 'escalate',
  capabilities: { nudge: true, reassign: true, cancel: true, escalate: true },
  version: 3, stale: false, updatedAt: '2026-10-29T12:00:00.000Z',
  elapsedMs: null, heartbeatAt: null, firstTokenAt: null, tokensSoFar: null,
  stallBasis: null, inferred: false,
}

const INTERNAL = '【主管内部】'
const DECISION = '【需要您决定】'

function prefixCount(text: string, prefix: string): number {
  return text.split(prefix).length - 1
}

describe('stall notification prefixes', () => {
  it('hides possibly_stalled, stalled and recovered behind the internal prefix', () => {
    for (const kind of ['possibly_stalled', 'stalled', 'recovered'] as const) {
      const text = notificationText(VIEW, kind)
      expect(text.startsWith(INTERNAL)).toBe(true)
      expect(text).not.toContain(DECISION)
      expect(prefixCount(text, INTERNAL)).toBe(1)
    }
  })

  it('uses exactly one user-decision prefix for escalation and no internal prefix', () => {
    const text = notificationText(VIEW, 'escalated')
    expect(text.startsWith(DECISION)).toBe(true)
    expect(text).not.toContain(INTERNAL)
    expect(prefixCount(text, DECISION)).toBe(1)
    expect(text).toContain('请用户裁决')
  })
})
