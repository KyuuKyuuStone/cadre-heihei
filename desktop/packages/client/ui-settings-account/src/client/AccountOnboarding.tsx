/** API Key credential onboarding for users without a stored account credential. */
import { useEffect, useRef } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AccountSectionInjected } from './AccountSection.tsx'

/** Enter the API Key step once for a keyless account; preserve completion for stored account credentials.
 * @param props - onboarding completion, account state and API Key action.
 * @returns no account authorization UI.
 */
export function AccountOnboarding({ complete, useApiKey, useAccount, setOnboarding }:
  PropsRuntime<'settings.models.sign-in'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>) {
  const accountStatus = useAccount(value => value.view?.status)
  const apiKeyRequested = useRef(false)
  useEffect(() => { setOnboarding(true); return () => { setOnboarding(false) } }, [setOnboarding])
  useEffect(() => {
    if (accountStatus === 'credential-stored') {
      apiKeyRequested.current = false
      complete()
      return
    }
    if (accountStatus !== 'signed-out' || apiKeyRequested.current) return
    apiKeyRequested.current = true
    useApiKey()
  }, [accountStatus, complete, useApiKey])
  return null
}
