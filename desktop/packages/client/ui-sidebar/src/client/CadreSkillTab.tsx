/** Per-conversation skill selection page, opened from the Conversation view tabs. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import {
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
  defaultProjectId(): string | undefined
}

type SkillTabProps = {
  readonly sessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
} & InjectFace<CadreSkillTabInjected>

const BUILTIN_SOURCES = /^(builtin|internal|cadre)$/iu
const isBuiltin = (entry: CadreSkillEntry): boolean =>
  entry.origin === 'builtin' || (entry.origin === undefined && BUILTIN_SOURCES.test(entry.source.trim()))

/** One Session's skill catalog, editable only by that Session's roster member. */
export function CadreSkillTab({ sessionId, useRoster, projectOfSession, defaultProjectId, t }: SkillTabProps) {
  const { members, status: rosterStatus, error: rosterError } = useRoster(state => state)
  const member = members.find(item => item.sessionId === sessionId)
  const readOnly = member === undefined
  const projectId = projectOfSession(sessionId) ?? (readOnly ? defaultProjectId() : undefined)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [preview, setPreview] = useState<CadreSkillPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (projectId === undefined || (member === undefined && rosterStatus !== 'ready')) return
    const request = ++requestVersion.current
    setBusy(true)
    setError(null)
    try {
      const catalog = await fetchSkillCatalog(
        projectId, sessionId, member === undefined ? undefined : sessionId, navigator.language,
      )
      if (request !== requestVersion.current) return
      const next = member === undefined ? catalog : catalog.filter(entry => entry.roles.includes(member.role))
      setEntries(next)
      setSelected(member === undefined ? [] : next.filter(entry => entry.selected).map(entry => entry.id))
    } catch (cause) {
      if (request === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === requestVersion.current) setBusy(false)
    }
  }, [member, projectId, rosterStatus, sessionId])

  useEffect(() => {
    void load()
    return () => { requestVersion.current += 1 }
  }, [load])

  if (member?.state === 'departed') return null
  if (member === undefined && rosterStatus !== 'ready') {
    if (rosterStatus === 'error' && rosterError !== null) {
      return <section className={css.page}><p className={css.error} role="alert">{rosterError}</p></section>
    }
    return null
  }
  if (projectId === undefined) {
    return <section className={css.page}><p className={css.error} role="alert">{t('skills.tab.noProject')}</p></section>
  }
  const save = async (): Promise<void> => {
    if (readOnly) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveMemberSkills(projectId, sessionId, sessionId, selected)
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
          {!readOnly && <p>{t('skills.tab.description')}</p>}
        </div>
      </header>
      {!readOnly && <div className={css.summary}>
        <span className={css.count}>{t('skills.tab.count', { count: String(selected.length) })}</span>
        <span className={css.total}>{t('skills.total', { count: String(skillTokenTotal(entries, selected)) })}</span>
      </div>}
      {entries.length === 0
        ? <div className={css.empty} data-skill-tab-empty><span aria-hidden="true">✦</span><p>{t('skills.empty')}</p></div>
        : <ul className={css.cards}>
          {entries.map((entry) => {
            const checked = !readOnly && selected.includes(entry.id)
            return (
              <li key={entry.id} className={checked ? `${css.card} ${css.cardSelected}` : css.card} data-skill-card>
                <div className={css.cardHead}>
                  {readOnly ? <span>{entry.name}</span> : <Checkbox checked={checked} label={entry.name}
                    onChange={() => {
                      setSelected(current => current.includes(entry.id)
                        ? current.filter(item => item !== entry.id)
                        : [...current, entry.id])
                    }} />}
                  <span className={css.cardToken}>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
                </div>
                <p className={css.cardDescription}>{entry.description}</p>
                <div className={css.cardMeta}>
                  <span>{entry.license}</span>
                  <span>{t(isBuiltin(entry) ? 'skills.group.builtin' : 'skills.group.installed')}</span>
                  {!readOnly && <Button variant="ghost" size="sm" onClick={() => {
                    void previewSkill(projectId, sessionId, entry.id).then(setPreview, (cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    })
                  }}>{t('skills.preview')}</Button>}
                </div>
              </li>
            )
          })}
        </ul>}
      {!readOnly && preview !== null && (
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
      {!readOnly && <div className={css.footer}>
        <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('skills.save')}</Button>
      </div>}
    </section>
  )
}
