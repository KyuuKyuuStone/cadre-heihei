/** Supervisor claim-verification badge beside the final assistant message. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import css from './CadreClaimBadge.module.css'

interface ClaimRecord {
  readonly sessionId: string
  readonly seq?: number
  readonly verdict: 'verified' | 'unverified' | 'historical'
  readonly pending: boolean
  readonly reason?: string
}

export interface CadreClaimBadgeInjected {
  readonly projectId: string | undefined
  readonly sessionId: string
  readonly hooks: { readonly roster: { subscribe(listener: () => void): () => void; getSnapshot(): CadreRosterState } }
}

const LABELS = {
  verified: 'claims.verified',
  unverified: 'claims.unverified',
  historical: 'claims.historical',
} as const

/** Renders nothing without a snapshot record or outside a supervisor Session. */
export function CadreClaimBadge({
  messageId, seq, projectId, sessionId, useRoster, t,
}: {
  readonly messageId: string
  readonly seq?: number
  readonly projectId: string | undefined
  readonly sessionId: string
  readonly useRoster: <T>(selector: (state: CadreRosterState) => T) => T
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const member = useRoster(state => state.members.find(item => item.sessionId === sessionId))
  const supervisor = member?.role === 'supervisor' && member.state !== 'departed'
  const [record, setRecord] = useState<ClaimRecord | null>(null)

  useEffect(() => {
    if (!supervisor || projectId === undefined || seq === undefined) {
      setRecord(null)
      return
    }
    let alive = true
    let timer: number | undefined
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/cadre/claims/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, actorSessionId: sessionId }),
        })
        const payload = await response.json() as { claims?: unknown }
        if (!alive || !response.ok || !Array.isArray(payload.claims)) return
        const claims = payload.claims as readonly ClaimRecord[]
        const found = claims.find(claim => claim.sessionId === sessionId && claim.seq === seq) ?? null
        setRecord(found)
        if (found?.pending === true) timer = window.setTimeout(() => { void load() }, 60_000)
      } catch {
        // Claim verification is advisory; a failed read never blocks the conversation.
      }
    }
    void load()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [projectId, seq, sessionId, supervisor])

  if (record === null) return null
  const key = record.pending ? 'claims.pending' : LABELS[record.verdict]
  return (
    <span
      className={record.pending ? `${css.badge} ${css.pending}` : `${css.badge} ${css[record.verdict]}`}
      data-cadre-claim={record.pending ? 'pending' : record.verdict}
      data-cadre-claim-message={messageId}
      title={record.reason}
    >
      {t(key)}
    </span>
  )
}
