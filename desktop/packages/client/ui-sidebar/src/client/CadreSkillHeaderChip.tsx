/** Always-visible skill count chip in the Session header for roster members. */
import { useEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import { activeSupervisorId, fetchSkillCatalog, type CadreSkillEntry, type CadreSkillsInjected } from './CadreSkills.tsx'
import css from './CadreSkillHeaderChip.module.css'

export interface CadreSkillHeaderChipInjected extends Pick<CadreSkillsInjected, 'openSkills'> {
  hooks: {
    roster: HostObservable<CadreRosterState>
    sessions: HostObservable<CadreSessionsState>
    revision: HostObservable<number>
  }
  projectOfSession(sessionId: string): string | undefined
}

type ChipProps = {
  readonly sessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
} & InjectFace<CadreSkillHeaderChipInjected>

/** Header chip: count selected skills, open the same supervisor picker, disabled for non-supervisors. */
export function CadreSkillHeaderChip({
  sessionId, useRoster, useSessions, useRevision, projectOfSession, openSkills, t,
}: ChipProps) {
  const members = useRoster(state => state.members)
  const sessions = useSessions(state => state.byId)
  const revision = useRevision(value => value)
  const member = members.find(item => item.sessionId === sessionId)
  const activeSupervisor = activeSupervisorId({ byId: sessions }, members)
  // A read-only count may be read by any supervisor, while editing requires the
  // active supervisor so the write actor is never an employee.
  const readActor = activeSupervisor ?? members.find(item => item.role === 'supervisor' && item.state !== 'departed')?.sessionId
  const projectId = readActor === undefined ? undefined : projectOfSession(readActor)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEntries(null)
    setError(null)
    if (member === undefined || readActor === undefined || projectId === undefined) return
    let cancelled = false
    void fetchSkillCatalog(projectId, readActor, sessionId, navigator.language).then(
      (next) => { if (!cancelled) setEntries(next) },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => { cancelled = true }
  }, [member, projectId, readActor, revision, sessionId])

  if (member === undefined || member.state === 'departed') return null
  const count = entries?.filter(entry => entry.selected).length
  const label = error !== null
    ? t('skills.header.chipError')
    : entries === null ? t('skills.header.chipLoading') : t('skills.header.chip', { count: String(count ?? 0) })
  const editable = activeSupervisor !== undefined
  return (
    <button
      type="button"
      className={css.chip}
      data-cadre-skill-chip
      disabled={!editable || readActor === undefined || projectId === undefined}
      title={error ?? t(editable ? 'skills.header.editHint' : 'skills.header.readOnlyHint')}
      aria-label={label}
      onClick={() => {
        if (activeSupervisor === undefined) return
        openSkills(
          sessionId,
          sessions[sessionId]?.displayTitle ?? sessionId,
          member.role === 'supervisor' ? 'supervisor' : 'worker',
          activeSupervisor,
        )
      }}
    >
      <span aria-hidden="true">✦</span>
      <span>{label}</span>
    </button>
  )
}
