/**
 * Global skill library: built-in packs are read-only; installation goes through
 * the skill-administrator conversation. Any session opens the full page; skill
 * IPC runs under the foreground session's own id, scoped to the resolved project.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterMember, CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import {
  addSkillToLibrary,
  fetchSkillCatalog,
  removeSkillFromLibrary,
  type CadreSkillEntry,
} from './CadreSkills.tsx'
import { createSkillAdminSession, listSkillAdminSessions, SkillAdminError, skillAdminErrorKey } from './CadreSkillAdmin.ts'
import css from './CadreSkillLibrary.module.css'

export interface CadreSkillLibraryInjected {
  hooks: { roster: HostObservable<CadreRosterState>; sessions: HostObservable<CadreSessionsState> }
  projectOfSession(sessionId: string): string | undefined
  /** Fallback project for a session that belongs to no project; undefined when none exists. */
  defaultProjectId(): string | undefined
  openSkillAdminSession(sessionId: string, workspaceId?: string): Promise<void>
}

interface ManualState {
  id: string
  name: string
  description: string
  roles: string[]
  tokenEstimate: string
  tools: string
  source: string
  license: string
  content: string
}

const EMPTY: ManualState = {
  id: '', name: '', description: '', roles: ['worker'], tokenEstimate: '',
  tools: '', source: 'manual', license: '', content: '',
}

const SKILL_SOURCES = {
  skillhub: 'https://skillhub.cn',
  clawhub: 'https://clawhub.ai',
  aiDesign: 'https://github.com/elayadesign/ai-design-skills',
  githubTopic: 'https://github.com/topics/agent-skills',
} as const

const BUILTIN_SOURCES = /^(builtin|internal|cadre)$/iu
const isBuiltin = (entry: CadreSkillEntry): boolean =>
  entry.origin === 'builtin' || (entry.origin === undefined && BUILTIN_SOURCES.test(entry.source.trim()))
const localizedDescription = (entry: CadreSkillEntry, t: PropsLocale<'sidebar'>['t']): string => {
  if (entry.id === 'ai-design' || entry.id === 'landing-page-design') return t('skills.desc.ai-design')
  return entry.description
}
const skillHref = (entry: CadreSkillEntry): string => {
  const homepage = entry.homepage?.trim() ?? ''
  return homepage !== '' ? homepage : entry.source.trim()
}

/**
 * Resolve the session id that authorizes skill IPC for the project. The host
 * admits any session while the project exists, so the foreground session acts
 * under its own id — roster member or not. Without a foreground session, the
 * page borrows the project supervisor, else its first non-departed member by
 * session id (mirroring the host's actorFor proxy rule).
 */
const actingSessionIdOf = (
  members: readonly CadreRosterMember[],
  projectId: string | undefined,
  activeSessionId: string | undefined,
  projectOfSession: (sessionId: string) => string | undefined,
): string | undefined => {
  if (projectId === undefined) return undefined
  if (activeSessionId !== undefined) return activeSessionId
  const inProject = members.filter(member =>
    member.state !== 'departed' && projectOfSession(member.sessionId) === projectId)
  const supervisor = inProject.find(member => member.role === 'supervisor')
  if (supervisor !== undefined) return supervisor.sessionId
  return [...inProject].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))[0]?.sessionId
}

/** Sidebar icon for the global skill library. */
export function CadreSkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <span className={css.icon} style={{ width: size, height: size }} aria-hidden="true">✦</span>
}

/** Global panel listing built-in and installed skills. */
export function CadreSkillLibraryPage({
  useRoster, useSessions, projectOfSession, defaultProjectId, openSkillAdminSession, t,
}: PropsRuntime<'main'> & InjectFace<CadreSkillLibraryInjected> & PropsLocale<'sidebar'>) {
  const members = useRoster(state => state.members)
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session.retainedBy.mainView ?? 0) > 0)?.[0])
  const sessionProjectId = activeSessionId === undefined ? undefined : projectOfSession(activeSessionId)
  const projectId = sessionProjectId ?? defaultProjectId()
  const actorSessionId = actingSessionIdOf(members, projectId, activeSessionId, projectOfSession)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState<ManualState>(EMPTY)
  const [tokenManual, setTokenManual] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (actorSessionId === undefined || projectId === undefined) return
    setBusy(true)
    setError(null)
    try {
      setEntries(await fetchSkillCatalog(projectId, actorSessionId, actorSessionId, navigator.language))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [actorSessionId, projectId])

  useEffect(() => { void load() }, [load])

  if (actorSessionId === undefined || projectId === undefined) {
    return (
      <section className={css.page} data-skill-library>
        <h1>{t('skills.library.title')}</h1>
        <p>{t('skills.library.readOnly')}</p>
      </section>
    )
  }

  const addManual = async (): Promise<void> => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(form.id) || form.id.length > 64) {
      setError(t('skills.error.id'))
      return
    }
    if (form.name.trim() === '' || form.content.trim() === '' || form.roles.length === 0) {
      setError(t('skills.error.required'))
      return
    }
    if (!/^\d+$/u.test(form.tokenEstimate)) {
      setError(t('skills.error.tokens'))
      return
    }
    if (entries.some(entry => entry.id === form.id && isBuiltin(entry))) {
      setError(t('skills.error.builtin'))
      return
    }
    if (entries.some(entry => entry.id === form.id)) {
      setError(t('skills.error.exists'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await addSkillToLibrary(projectId, actorSessionId, {
        ...form,
        tokenEstimate: Number(form.tokenEstimate),
        tools: form.tools.split(',').map(item => item.trim()).filter(item => item !== ''),
        overwrite: false,
      })
      setAdvanced(false)
      setNotice(t('skills.notice.added'))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openInstaller = async (): Promise<void> => {
    setOpening(true)
    setOpenError(null)
    try {
      const sessions = await listSkillAdminSessions(projectId)
      const existing = [...sessions]
        .filter(session => typeof session.sessionId === 'string' && session.sessionId !== '')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const chosen = existing ?? await createSkillAdminSession(projectId)
      if (chosen.workspaceId === undefined) {
        await openSkillAdminSession(chosen.sessionId)
      } else {
        await openSkillAdminSession(chosen.sessionId, chosen.workspaceId)
      }
    } catch (cause) {
      setOpenError(cause instanceof SkillAdminError
        ? t(skillAdminErrorKey(cause.code) as never)
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpening(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('skills.confirmRemove', { id }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await removeSkillFromLibrary(projectId, actorSessionId, id)
      setNotice(t('skills.notice.removed'))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const group = (title: string, rows: readonly CadreSkillEntry[], deletable: boolean) => (
    <section className={css.group}>
      <h2>{title}</h2>
      {rows.length === 0
        ? <p className={css.groupEmpty}>{t('skills.library.groupEmpty')}</p>
        : (
          <ul className={css.list}>
            {rows.map(entry => (
              <li key={entry.id} className={css.card}>
                <div className={css.cardHead}>
                  <strong>{entry.name}</strong>
                  {entry.selected && <span className={css.selected}>{t('skills.selected')}</span>}
                </div>
                <p>{localizedDescription(entry, t)}</p>
                <details className={css.details}>
                  <summary>{t('skills.details')}</summary>
                  <div className={css.meta}>
                    <span>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
                    <span>{entry.tools.join(', ') || t('skills.toolsNone')}</span>
                    {entry.author !== undefined && entry.author.trim() !== '' && (
                      <span>{t('skills.author', { author: entry.author })}</span>
                    )}
                    <span>{t('skills.licenseLabel', { license: entry.license })}</span>
                    {/^https?:\/\//iu.test(skillHref(entry))
                      ? <a href={skillHref(entry)} target="_blank" rel="noopener noreferrer">{t('skills.upstream')}</a>
                      : <span>{skillHref(entry)}</span>}
                  </div>
                </details>
                {deletable && (
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => { void remove(entry.id) }}>{t('skills.remove')}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
    </section>
  )

  const builtin = entries.filter(isBuiltin)
  const installed = entries.filter(entry => !isBuiltin(entry))

  return (
    <section className={css.page} data-skill-library>
      <header className={css.header}>
        <div>
          <h1>{t('skills.library.title')}</h1>
          <p>{t('skills.library.description')}</p>
        </div>
        <div className={css.headerActions}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            if (!advanced) setForm({ ...EMPTY, tools: t('skills.defaultTools'), license: t('skills.defaultLicense') })
            setAdvanced(value => !value)
          }}>{t('skills.advanced')}</Button>
        </div>
      </header>
      <section className={css.installPanel} data-skill-install-entry>
        <div className={css.installHead}>
          <div>
            <h2>{t('skills.install.panelTitle')}</h2>
            <p>{t('skills.install.panelDescription')}</p>
          </div>
          <Button variant="primary" disabled={opening} onClick={() => { void openInstaller() }}>
            {opening ? t('skills.install.opening') : t('skills.install.open')}
          </Button>
        </div>
        {openError !== null && <p className={css.error} role="alert">{openError}</p>}
      </section>
      <div className={css.sources} data-skill-sources>
        <span className={css.sourcesLabel}>{t('skills.sources.label')}</span>
        <a href={SKILL_SOURCES.skillhub} target="_blank" rel="noopener noreferrer">{t('skills.sources.skillhub')}</a>
        <a href={SKILL_SOURCES.clawhub} target="_blank" rel="noopener noreferrer">{t('skills.sources.clawhub')}</a>
        <a href={SKILL_SOURCES.aiDesign} target="_blank" rel="noopener noreferrer">{t('skills.sources.aiDesign')}</a>
        <a href={SKILL_SOURCES.githubTopic} target="_blank" rel="noopener noreferrer">{t('skills.sources.githubTopic')}</a>
        <p>{t('skills.sources.caution')}</p>
      </div>
      {advanced && (
        <div className={css.install} data-skill-install>
          <div className={css.fields}>
            <label>{t('skills.field.id')}<Input value={form.id} disabled={busy}
              onChange={(event) => { setForm({ ...form, id: event.target.value.trim() }) }} /></label>
            <label>{t('skills.field.name')}<Input value={form.name} disabled={busy}
              onChange={(event) => { setForm({ ...form, name: event.target.value }) }} /></label>
            <label>{t('skills.field.description')}<Input value={form.description} disabled={busy}
              onChange={(event) => { setForm({ ...form, description: event.target.value }) }} /></label>
            <label>{t('skills.field.tokens')}<Input type="number" min={0} value={form.tokenEstimate} disabled={busy}
              onChange={(event) => { setTokenManual(true); setForm({ ...form, tokenEstimate: event.target.value }) }} /></label>
            <label>{t('skills.field.tools')}<Input value={form.tools} disabled={busy}
              onChange={(event) => { setForm({ ...form, tools: event.target.value }) }} /></label>
            <label>{t('skills.field.source')}<Input value={form.source} disabled={busy}
              onChange={(event) => { setForm({ ...form, source: event.target.value }) }} /></label>
            <label>{t('skills.field.license')}<Input value={form.license} disabled={busy}
              onChange={(event) => { setForm({ ...form, license: event.target.value }) }} /></label>
            <div className={css.roles}>
              <span>{t('skills.field.role')}</span>
              <Checkbox checked={form.roles.includes('worker')} label={t('skills.role.worker')}
                onChange={(next) => { setForm({ ...form, roles: next ? [...form.roles, 'worker'] : form.roles.filter(item => item !== 'worker') }) }} />
              <Checkbox checked={form.roles.includes('supervisor')} label={t('skills.role.supervisor')}
                onChange={(next) => { setForm({ ...form, roles: next ? [...form.roles, 'supervisor'] : form.roles.filter(item => item !== 'supervisor') }) }} />
            </div>
            <label>{t('skills.field.content')}
              <textarea className={css.textarea} value={form.content} rows={6} disabled={busy}
                onChange={(event) => {
                  const content = event.target.value
                  setForm({ ...form, content, ...(tokenManual ? {} : { tokenEstimate: String(Math.ceil(content.length / 4)) }) })
                }} />
            </label>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void addManual() }}>{t('skills.addSave')}</Button>
          </div>
        </div>
      )}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      {entries.length === 0 && (
        <p className={css.emptyState}>{t(busy ? 'skills.library.loading' : 'skills.library.empty')}</p>
      )}
      {entries.length > 0 && group(t('skills.group.builtin'), builtin, false)}
      {entries.length > 0 && group(t('skills.group.installed'), installed, true)}
    </section>
  )
}
