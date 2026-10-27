// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateNotice, type UpdateNoticeProps } from '../src/client/UpdateNotice.tsx'
import { UpdateCheckRow } from '../src/client/UpdateCheckRow.tsx'
import type { CadreUpdateBridge, CadreUpdateNotice } from '../src/client/update-bridge.ts'

afterEach(() => {
  cleanup()
  delete (window as unknown as { cadre?: CadreUpdateBridge }).cadre
})

const t = (key: string): string => key

function noticeProps(wide: boolean): UpdateNoticeProps {
  return { wide, t } as unknown as UpdateNoticeProps
}

function installBridge(bridge: CadreUpdateBridge): CadreUpdateBridge {
  ;(window as unknown as { cadre?: CadreUpdateBridge }).cadre = bridge
  return bridge
}

const available: CadreUpdateNotice = {
  kind: 'available', version: '9.9.9', url: 'https://github.com/KyuuKyuuStone/cadre-heihei/releases/latest',
}

describe('UpdateNotice', () => {
  it('renders the available version and opens the fixed release page', async () => {
    const openReleasePage = vi.fn(async () => {})
    const dismissUpdateNotice = vi.fn(async () => null)
    installBridge({
      getUpdateNotice: async () => available,
      openReleasePage,
      dismissUpdateNotice,
      subscribeUpdateNotice: () => () => {},
    })
    render(<UpdateNotice {...noticeProps(true)} />)

    expect(await screen.findByText(/9\.9\.9/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'update.view' }))
    expect(openReleasePage).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'update.dismiss' }))
    await waitFor(() => { expect(dismissUpdateNotice).toHaveBeenCalledWith('available') })
  })

  it('dismisses the one-time upgrade notice without opening a page', async () => {
    const openReleasePage = vi.fn(async () => {})
    const dismissUpdateNotice = vi.fn(async () => null)
    installBridge({
      getUpdateNotice: async () => ({ kind: 'upgraded', version: '0.9.2', fromVersion: '0.9.1' }),
      openReleasePage,
      dismissUpdateNotice,
      subscribeUpdateNotice: () => () => {},
    })
    render(<UpdateNotice {...noticeProps(true)} />)

    expect(await screen.findByText('update.upgraded')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'update.dismiss' }))
    await waitFor(() => { expect(dismissUpdateNotice).toHaveBeenCalledWith('upgraded') })
    expect(openReleasePage).not.toHaveBeenCalled()
  })

  it('follows pushed notices and hides when the main process clears them', async () => {
    let push: ((notice: CadreUpdateNotice | null) => void) | undefined
    installBridge({
      getUpdateNotice: async () => null,
      subscribeUpdateNotice: (listener) => { push = listener; return () => {} },
    })
    render(<UpdateNotice {...noticeProps(true)} />)
    expect(screen.queryByText(/9\.9\.9/)).toBeNull()
    await waitFor(() => { expect(push).toBeDefined() })

    act(() => { push?.(available) })
    expect(await screen.findByText(/9\.9\.9/)).toBeTruthy()

    act(() => { push?.(null) })
    await waitFor(() => { expect(screen.queryByText(/9\.9\.9/)).toBeNull() })
  })

  it('renders nothing without the desktop bridge', () => {
    const { container } = render(<UpdateNotice {...noticeProps(true)} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows a compact rail affordance when the sidebar is collapsed', async () => {
    installBridge({ getUpdateNotice: async () => available, subscribeUpdateNotice: () => () => {} })
    render(<UpdateNotice {...noticeProps(false)} />)
    const rail = await screen.findByRole('button', { name: 'update.available' })
    expect(rail.textContent).toBe('●')
  })
})

describe('UpdateCheckRow', () => {
  it('reflects the persisted switch and writes changes through the bridge', async () => {
    const setUpdateCheckEnabled = vi.fn(async (next: boolean) => next)
    installBridge({
      getUpdateCheckEnabled: async () => true,
      setUpdateCheckEnabled,
    })
    render(<UpdateCheckRow {...({ t } as unknown as Parameters<typeof UpdateCheckRow>[0])} />)

    const toggle = await screen.findByRole('switch', { name: 'update.settings.label' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    await waitFor(() => { expect(setUpdateCheckEnabled).toHaveBeenCalledWith(false) })
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
  })

  it('reports a failed write and keeps the row visible', async () => {
    installBridge({
      getUpdateCheckEnabled: async () => true,
      setUpdateCheckEnabled: async () => { throw new Error('disk full') },
    })
    render(<UpdateCheckRow {...({ t } as unknown as Parameters<typeof UpdateCheckRow>[0])} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'update.settings.label' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('update.settings.saveFailed')).toBeTruthy()
  })

  it('stays hidden in shells without the bridge', () => {
    const { container } = render(<UpdateCheckRow {...({ t } as unknown as Parameters<typeof UpdateCheckRow>[0])} />)
    expect(container.innerHTML).toBe('')
  })
})
