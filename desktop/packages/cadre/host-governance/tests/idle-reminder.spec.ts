import { describe, expect, it } from 'vitest'
import { IdleReminderService } from '../src/idle-reminder.ts'
import type { EmailEvent } from '@deepseek-ai/dsh-cadre-email-notify'

const assistant = (text: string): { type: string; data: unknown } => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})
const user = { type: 'user/message', data: {} }

describe('idle reminder', () => {
  it('fires once after ten minutes, cancels on user reply, and re-arms a new idle segment', async () => {
    let now = 0
    let callback: (() => void) | undefined
    let delay = 0
    const sent: EmailEvent[] = []
    const attachmentsSeen: unknown[] = []
    const service = new IdleReminderService({
      isSupervisor: () => true,
      projectOf: () => 'p1',
      policyOf: () => ({ enabled: true, minutes: 10 }),
      statsOf: () => ({ delivered: 2, verified: 1, failed: 1 }),
      capture: async () => Buffer.from('png-bytes'),
      send: async (event, attachments) => {
        sent.push(event)
        attachmentsSeen.push(attachments)
        return { ok: true, status: 'sent' }
      },
      now: () => now,
      setTimer: (fn, ms) => { callback = fn; delay = ms; return 1 },
      clearTimer: () => { callback = undefined },
      log: () => {},
    })
    service.handle('s1', { type: 'session/title', data: { title: '发布讨论' } })
    service.handle('s1', assistant('x'.repeat(500)))
    expect(delay).toBe(600_000)
    now += 600_000
    callback?.()
    await new Promise(resolve => { setImmediate(resolve) })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'idle-reminder', projectId: 'p1', title: '发布讨论', idleMinutes: 10,
      taskStats: { delivered: 2, verified: 1, failed: 1 }, screenshotFailed: false,
    })
    expect((sent[0] as { summary: string }).summary).toHaveLength(300)
    expect(attachmentsSeen[0]).toEqual([expect.objectContaining({ filename: 'cadre-report-s1.png', contentType: 'image/png' })])
    expect(service.isPaused('s1')).toBe(true)

    service.handle('s1', assistant('second without user'))
    callback?.()
    await new Promise(resolve => { setImmediate(resolve) })
    expect(sent).toHaveLength(1)
    expect(service.isPaused('s1')).toBe(true)

    service.handle('s1', user)
    expect(service.isPaused('s1')).toBe(false)
    service.handle('s1', assistant('next reply'))
    expect(delay).toBe(600_000)
    now += 600_000
    callback?.()
    await new Promise(resolve => { setImmediate(resolve) })
    expect(sent).toHaveLength(2)
    expect((sent[1] as { summary: string }).summary).toBe('next reply')
  })

  it('does not schedule when disabled, non-supervisor, or cancelled by a user reply', async () => {
    let callback: (() => void) | undefined
    let scheduled = 0
    const sent: EmailEvent[] = []
    const make = (enabled: boolean, supervisor: boolean): IdleReminderService => new IdleReminderService({
      isSupervisor: () => supervisor,
      projectOf: () => 'p1',
      policyOf: () => ({ enabled, minutes: 10 }),
      send: async (event, _attachments) => { sent.push(event); return { ok: true, status: 'sent' } },
      setTimer: fn => { scheduled += 1; callback = fn; return 1 },
      clearTimer: () => { callback = undefined },
      log: () => {},
    })
    const disabled = make(false, true)
    disabled.handle('s1', assistant('no'))
    expect(scheduled).toBe(0)
    const switchedOff = new IdleReminderService({
      isSupervisor: () => true,
      projectOf: () => 'p1',
      policyOf: () => undefined,
      send: async event => { sent.push(event); return { ok: true, status: 'sent' } },
      setTimer: fn => { scheduled += 1; callback = fn; return 1 },
      clearTimer: () => {},
      log: () => {},
    })
    switchedOff.handle('s1', assistant('no switch'))
    expect(scheduled).toBe(0)
    const worker = make(true, false)
    worker.handle('w1', assistant('no'))
    expect(scheduled).toBe(0)
    const enabled = make(true, true)
    enabled.handle('s1', assistant('hello'))
    const pending = callback
    enabled.handle('s1', user)
    pending?.()
    await new Promise(resolve => { setImmediate(resolve) })
    expect(sent).toHaveLength(0)
  })

  it('sends the report body with screenshotFailed when capture fails', async () => {
    let callback: (() => void) | undefined
    const sent: EmailEvent[] = []
    let attachmentsSeen: unknown
    const service = new IdleReminderService({
      isSupervisor: () => true,
      projectOf: () => 'p1',
      policyOf: () => ({ enabled: true, minutes: 10 }),
      capture: async () => { throw new Error('capture unavailable') },
      send: async (event, attachments) => {
        sent.push(event)
        attachmentsSeen = attachments
        return { ok: true, status: 'sent' }
      },
      setTimer: fn => { callback = fn; return 1 },
      clearTimer: () => {},
      log: () => {},
    })
    service.handle('s1', assistant('done'))
    callback?.()
    await new Promise(resolve => { setImmediate(resolve) })
    expect(attachmentsSeen).toBeUndefined()
    expect(sent[0]).toMatchObject({ kind: 'idle-reminder', screenshotFailed: true })
  })
})
