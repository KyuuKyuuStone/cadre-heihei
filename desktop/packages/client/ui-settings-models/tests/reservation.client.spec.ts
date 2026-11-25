/** The reservation consequence view: readable numbers only, warnings the page owns. */
import { describe, expect, it } from 'vitest'
import { reservationView } from '../src/client/reservation.ts'

describe('reservationView', () => {
  it('shows nothing when neither a stored value nor an inherited fallback reserves tokens', () => {
    expect(reservationView({ stored: undefined })).toBeUndefined()
    expect(reservationView({ stored: undefined, inherited: undefined })).toBeUndefined()
  })

  it.each([
    ['a non-number', '32768'],
    ['a fraction', 32768.5],
    ['zero', 0],
    ['a negative count', -1],
  ])('rejects %s as a stored reservation', (_label, stored) => {
    expect(reservationView({ stored })).toBeUndefined()
  })

  it('prefers the stored value over the inherited fallback', () => {
    expect(reservationView({ stored: 8192, inherited: 256_000 })).toMatchObject({
      reserved: 8192, inherited: false,
    })
  })

  it('falls back to the inherited reservation, marked as inherited', () => {
    expect(reservationView({ stored: undefined, inherited: 256_000 })).toMatchObject({
      reserved: 256_000, inherited: true,
    })
  })

  it.each([['a non-number', 'big'], ['a fraction', 0.5], ['zero', 0], ['a negative count', -5]])(
    'ignores %s as an inherited fallback',
    (_label, inherited) => {
      expect(reservationView({ stored: undefined, inherited })).toBeUndefined()
    },
  )

  it('computes the window share to one decimal', () => {
    expect(reservationView({ stored: 393_000, contextWindow: 500_000 })).toMatchObject({
      percent: '78.6', warning: 'window-share', suggested: undefined,
    })
  })

  it('leaves the share empty when the window is unknown', () => {
    expect(reservationView({ stored: 32_768 })).toMatchObject({
      percent: '', warning: undefined, suggested: undefined,
    })
  })

  it.each([['a non-number', '1M'], ['a fraction', 1.5], ['zero', 0], ['a negative count', -1]])(
    'treats %s as an unknown window',
    (_label, contextWindow) => {
      expect(reservationView({ stored: 32_768, contextWindow })).toMatchObject({ percent: '' })
    },
  )

  it('warns above the readable default and suggests adopting it', () => {
    expect(reservationView({
      stored: 393_000, contextWindow: 500_000, outputDefault: 32_768,
    })).toEqual({
      reserved: 393_000, inherited: false, percent: '78.6',
      warning: 'above-default', suggested: 32_768,
    })
  })

  it('marks an inherited reservation above the default as inherited too', () => {
    expect(reservationView({ stored: undefined, inherited: 393_000, outputDefault: 32_768 })).toMatchObject({
      inherited: true, warning: 'above-default', suggested: 32_768,
    })
  })

  it('never warns when the reservation equals the deployment default', () => {
    expect(reservationView({ stored: 32_768, contextWindow: 65_536, outputDefault: 32_768 })).toMatchObject({
      warning: undefined, suggested: undefined,
    })
  })

  it('never warns below the default even at a large window share', () => {
    expect(reservationView({ stored: 32_768, contextWindow: 40_000, outputDefault: 65_536 })).toMatchObject({
      percent: '81.9', warning: undefined, suggested: undefined,
    })
  })

  it.each([['a non-number', '32K'], ['a fraction', 0.5], ['zero', 0], ['a negative count', -1]])(
    'treats %s as an unreadable default and falls back to the share rule',
    (_label, outputDefault) => {
      expect(reservationView({ stored: 393_000, contextWindow: 500_000, outputDefault })).toMatchObject({
        warning: 'window-share', suggested: undefined,
      })
    },
  )

  it('warns on the share alone at exactly half the window when no default is readable', () => {
    expect(reservationView({ stored: 250_000, contextWindow: 500_000 })).toMatchObject({
      percent: '50.0', warning: 'window-share', suggested: undefined,
    })
  })

  it('stays quiet below half the window when no default is readable', () => {
    expect(reservationView({ stored: 249_999, contextWindow: 500_000 })).toMatchObject({
      warning: undefined, suggested: undefined,
    })
  })

  it('still warns when the reservation exceeds the whole window', () => {
    expect(reservationView({ stored: 600_000, contextWindow: 500_000 })).toMatchObject({
      percent: '120.0', warning: 'window-share',
    })
  })
})