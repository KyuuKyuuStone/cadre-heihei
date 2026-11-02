import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'

/** One open token-panel request addressed to a Session. */
export interface CadreTokenRequest {
  readonly sessionId: string
  readonly projectId: string
  readonly label: string
  readonly token: number
}

/** Token panel injection: request source, roster hook, and open/close callbacks. */
export interface CadreTokenInjected {
  readonly hooks: {
    readonly tokenRequest: HostObservable<CadreTokenRequest | null>
    readonly roster: HostObservable<CadreRosterState>
  }
  readonly openToken: (sessionId: string, projectId: string, label: string) => void
  readonly closeToken: () => void
}
