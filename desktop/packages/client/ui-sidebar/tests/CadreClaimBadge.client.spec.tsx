// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { CadreClaimBadge } from '../src/client/CadreClaimBadge.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response

function roster(role: 'supervisor' | 'worker'): CadreRosterState {
  return {
    status: 'ready',
    members: [{ sessionId: 's1', role, displayName: 'Member', state: 'available' }],
    error: null,
  }
}

function mount(role: 'supervisor' | 'worker' = 'supervisor', seq = 7) {
  return render(
    <CadreClaimBadge
      messageId="m1"
      seq={seq}
      projectId="p1"
      sessionId="s1"
      useRoster={selector => selector(roster(role))}
      t={t}
    />,
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Cadre claim badge', () => {
  it.each([
    ['verified', '已核实'],
    ['unverified', '未核实'],
    ['historical', '历史'],
  ] as const)('renders the %s verdict', async (verdict, label) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      claims: [{ sessionId: 's1', seq: 7, verdict, pending: false }],
    })))
    mount()
    expect(await screen.findByText(label)).toBeTruthy()
  })

  it('renders nothing when there is no claim for the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      claims: [{ sessionId: 's1', seq: 9, verdict: 'verified', pending: false }],
    })))
    const view = mount()
    await act(async () => { await Promise.resolve() })
    expect(view.container.firstChild).toBeNull()
  })

  it('does not fetch or render outside a supervisor Session', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const view = mount('worker')
    expect(view.container.firstChild).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes a pending claim after 60 seconds and upgrades it', async () => {
    vi.useFakeTimers()
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return json({
        claims: [{ sessionId: 's1', seq: 7, verdict: call === 1 ? 'unverified' : 'verified', pending: call === 1 }],
      })
    }))
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('核实中')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByText('已核实')).toBeTruthy()
    expect(call).toBe(2)
  })

  it('stays hidden when the snapshot request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const view = mount()
    await act(async () => { await Promise.resolve() })
    expect(view.container.firstChild).toBeNull()
  })
})
