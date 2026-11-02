import { describe, expect, it } from 'vitest'
import { SessionPresence, TYPING_TTL_MS } from '../src/presence.ts'

function clock(): {
  presence: SessionPresence
  advance(ms: number): void
} {
  let now = 0
  let timer: (() => void) | undefined
  const presence = new SessionPresence({
    now: () => now,
    setTimer: callback => { timer = callback; return 1 },
    clearTimer: () => { timer = undefined },
  })
  return {
    presence,
    advance: ms => { now += ms; if (ms >= TYPING_TTL_MS) timer?.() },
  }
}

describe('session typing presence', () => {
  it('marks typing, expires after the TTL, and treats no presence as idle', () => {
    const { presence, advance } = clock()
    expect(presence.isTyping('s1')).toBe(false)
    expect(presence.mark('s1', true)).toMatchObject({ sessionId: 's1', typing: true })
    expect(presence.isTyping('s1')).toBe(true)
    advance(TYPING_TTL_MS)
    expect(presence.isTyping('s1')).toBe(false)
  })

  it('resolves waiters on explicit stop and on TTL expiry', async () => {
    const { presence, advance } = clock()
    presence.mark('s1', true)
    let stopped = false
    const first = presence.whenIdle('s1').then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    presence.mark('s1', false)
    await first
    expect(stopped).toBe(true)

    presence.mark('s2', true)
    let expired = false
    const second = presence.whenIdle('s2').then(() => { expired = true })
    await Promise.resolve()
    advance(TYPING_TTL_MS)
    await second
    expect(expired).toBe(true)
  })

  it('refreshes the TTL on repeated reports and clears on dispose', async () => {
    const { presence, advance } = clock()
    presence.mark('s1', true)
    advance(TYPING_TTL_MS)
    presence.mark('s1', true)
    advance(TYPING_TTL_MS - 1)
    expect(presence.isTyping('s1')).toBe(true)
    let idle = false
    const wait = presence.whenIdle('s1').then(() => { idle = true })
    presence.dispose()
    await wait
    expect(idle).toBe(true)
    expect(presence.isTyping('s1')).toBe(false)
  })
})
