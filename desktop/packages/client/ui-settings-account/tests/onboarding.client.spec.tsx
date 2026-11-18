// @vitest-environment jsdom
/** Keyless onboarding enters the API Key step without exposing account authorization. */
import { StrictMode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountOnboarding } from '../src/client/AccountOnboarding.tsx'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const theme: ThemeSnapshot = {
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}
const signedOut: AccountSnapshot = {
  view: { status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } },
  details: undefined, avatar: undefined, failed: false,
}

function fixture(initial: AccountSnapshot) {
  let account = initial
  const unused = (): never => { throw new Error('AccountOnboarding does not consume global hooks') }
  const globals: GlobalStandardProps = {
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
    ...allowAllAccess,
  }
  const props = {
    ...globals,
    hasRunningAccountTasks: vi.fn(async () => false),
    complete: vi.fn(), useApiKey: vi.fn(), setOnboarding: vi.fn(), showLogin: vi.fn(),
    useAccount: <T,>(select: (snapshot: AccountSnapshot) => T) => select(account),
    useTheme: <T,>(select: (snapshot: ThemeSnapshot) => T) => select(theme),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    contactUs: vi.fn(), t: makeTranslate(en),
    refreshAccount: vi.fn(async () => {}), bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    avatarFailed: vi.fn(),
  }
  return { props, setAccount: (next: AccountSnapshot) => { account = next } }
}

it('enters API Key once when keyless and never renders account authorization', () => {
  const state = fixture({ ...signedOut, view: undefined })
  const view = render(<AccountOnboarding {...state.props} />)
  expect(state.props.setOnboarding).toHaveBeenCalledExactlyOnceWith(true)
  expect(state.props.useApiKey).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  state.setAccount(signedOut)
  view.rerender(<AccountOnboarding {...state.props} />)
  expect(state.props.useApiKey).toHaveBeenCalledOnce()
  view.rerender(<AccountOnboarding {...state.props} />)
  view.rerender(<AccountOnboarding {...state.props} />)
  expect(state.props.useApiKey).toHaveBeenCalledOnce()
  expect(state.props.start).not.toHaveBeenCalled()
  expect(state.props.showLogin).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  expect(state.props.setOnboarding).toHaveBeenLastCalledWith(false)
  expect(state.props.useApiKey).toHaveBeenCalledOnce()
})

it('does not repeat the API Key route across StrictMode effect cleanup', () => {
  const state = fixture(signedOut)
  const view = render(<StrictMode><AccountOnboarding {...state.props} /></StrictMode>)
  view.rerender(<StrictMode><AccountOnboarding {...state.props} /></StrictMode>)
  expect(state.props.useApiKey).toHaveBeenCalledOnce()
  expect(state.props.start).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  expect(state.props.useApiKey).toHaveBeenCalledOnce()
})

it('completes an existing account credential without entering API Key onboarding', () => {
  const state = fixture({ ...signedOut, view: { ...signedOut.view!, status: 'credential-stored' } })
  const view = render(<AccountOnboarding {...state.props} />)
  view.rerender(<AccountOnboarding {...state.props} />)
  expect(state.props.complete).toHaveBeenCalledOnce()
  expect(state.props.useApiKey).not.toHaveBeenCalled()
  expect(state.props.start).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})
