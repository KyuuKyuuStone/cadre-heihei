/** Per-conversation skill selection page, opened from the Conversation view tabs. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import {
  CadreSkillPicker,
  fetchSkillCatalog,
  previewSkill,
  saveMemberSkills,
  skillTokenTotal,
  type CadreSkillEntry,
  type CadreSkillPreview,
} from './CadreSkills.tsx'
import css from './CadreSkillTab.module.css'

export interface CadreSkillTabInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
  projectOfSession(sessionId: string): string | undefined
}

type SkillTabProps = {
  readonly sessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
} & InjectFace<CadreSkillTabInjected>

/** One Session's bound skills, editable by that Session's roster member. */
export function CadreSkillTab({ sessionId, useRoster, projectOfSession, t }: SkillTabProps) {
  const members = useRoster(state => state.members)
  const member = members.find(item => item.sessionId === sessionId)
  const projectId = projectOfSession(sessionId)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [targetId, setTargetId] = useState(sessionId)
  const [preview, setPreview] = useState<CadreSkillPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const isSupervisor = member?.role === 'supervisor'
  const target = members.find(item => item.sessionId === targetId && item.state !== 'departed') ?? member
  const targetSessionId = target?.sessionId ?? sessionId

  const load = useCallback(async (): Promise<void> => {
    if (member === undefined || projectId === undefined || target === undefined) return
    setBusy(true)
    setError(null)
    try {
      const next = (await fetchSkillCatalog(projectId, sessionId, targetSessionId, navigator.language))
        .filter(entry => entry.roles.includes(target.role))
      setEntries(next)
      setSelected(next.filter(entry => entry.selected).map(entry => entry.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [member, projectId, sessionId, target, targetSessionId])

  useEffect(() => { void load() }, [load])

  if (member === undefined || member.state === 'departed') return null
  if (projectId === undefined) {
    return <section className={css.page}><p className={css.error} role="alert">{t('skills.tab.noProject')}</p></section>
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveMemberSkills(projectId, sessionId, targetSessionId, selected)
      setNotice(t('skills.tab.saved'))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={css.page} data-cadre-skill-tab>
      <header className={css.header}>
        <div>
          <h1>{t('skills.tab.title')}</h1>
          <p>{t('skills.tab.description')}</p>
          {isSupervisor && (
            <label className={css.target}>
              <span>{t('skills.tab.target')}</span>
              <select value={targetSessionId} disabled={busy}
                onChange={(event) => { setTargetId(event.target.value) }}>
                {members.filter(item => item.state !== 'departed').map(item => (
                  <option key={item.sessionId} value={item.sessionId}>{item.displayName}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <span className={css.count}>{t('skills.tab.count', { count: String(selected.length) })}</span>
      </header>
      <p className={css.total}>{t('skills.total', { count: String(skillTokenTotal(entries, selected)) })}</p>
      <CadreSkillPicker entries={entries} selected={selected} t={t}
        onToggle={(id) => {
          setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
        }}
        onPreview={(id) => {
          void previewSkill(projectId, sessionId, id).then(setPreview, (cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause))
          })
        }} />
      {preview !== null && (
        <div className={css.preview} data-skill-tab-preview>
          <div className={css.previewHead}>
            <strong>{preview.id}</strong>
            <span>{preview.license}</span>
            <Button variant="ghost" size="sm" onClick={() => { setPreview(null) }}>{t('skills.closePreview')}</Button>
          </div>
          <pre className={css.previewBody}>{preview.content}</pre>
        </div>
      )}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
      {notice !== null && <p className={css.notice} role="status">{notice}</p>}
      <div className={css.footer}>
        <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('skills.save')}</Button>
      </div>
    </section>
  )
}
