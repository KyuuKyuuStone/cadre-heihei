/**
 * Global skill library: built-in packs are read-only; installation goes through
 * the skill-administrator conversation. Member settings only select.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import {
  addSkillToLibrary,
  fetchSkillCatalog,
  removeSkillFromLibrary,
  type CadreSkillEntry,
} from './CadreSkills.tsx'
import { CadreSkillAdminDialog } from './CadreSkillAdminDialog.tsx'
import { CadreSkillInstallDialog } from './CadreSkillInstallDialog.tsx'
import css from './CadreSkillLibrary.module.css'

export interface CadreSkillLibraryInjected {
  hooks: { roster: HostObservable<CadreRosterState>; sessions: HostObservable<CadreSessionsState> }
  projectOfSession(sessionId: string): string | undefined
  openSkillAdminSession(sessionId: string): Promise<void>
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

/** Sidebar icon for the global skill library. */
export function CadreSkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <span className={css.icon} style={{ width: size, height: size }} aria-hidden="true">✦</span>
}

/** Global panel listing built-in and installed skills. */
export function CadreSkillLibraryPage({
  useRoster, useSessions, projectOfSession, openSkillAdminSession, t,
}: PropsRuntime<'main'> & InjectFace<CadreSkillLibraryInjected> & PropsLocale<'sidebar'>) {
  const members = useRoster(state => state.members)
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session.retainedBy.mainView ?? 0) > 0)?.[0])
  const actor = members.find(member => member.sessionId === activeSessionId)
  const isSupervisor = actor?.role === 'supervisor'
  // Installation runs as a supervisor even from an employee Session; only a
  // project without any supervisor is unavailable.
  const installActorId = isSupervisor
    ? actor.sessionId
    : members.find(member => member.role === 'supervisor' && member.state !== 'departed')?.sessionId
  const projectId = actor === undefined ? undefined : projectOfSession(actor.sessionId)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState<ManualState>(EMPTY)
  const [tokenManual, setTokenManual] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)

  const load = useCallback(async () => {
    if (actor === undefined || projectId === undefined) return
    setBusy(true)
    setError(null)
    try {
      // A worker reads their own selection; a supervisor reads the library view.
      setEntries(await fetchSkillCatalog(
        projectId,
        actor.sessionId,
        isSupervisor ? undefined : actor.sessionId,
        navigator.language,
      ))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [actor, isSupervisor, projectId])

  useEffect(() => { void load() }, [load])

  if (actor === undefined || projectId === undefined) {
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
      await addSkillToLibrary(projectId, actor.sessionId, {
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

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('skills.confirmRemove', { id }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await removeSkillFromLibrary(projectId, actor.sessionId, id)
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
          <Button variant="primary" disabled={installActorId === undefined || busy}
            title={installActorId === undefined ? t('skills.library.noSupervisor') : undefined}
            onClick={() => { if (installActorId !== undefined) setInstallOpen(true) }}>
            {t('skills.admin.installEntry')}
          </Button>
          {isSupervisor && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
              if (!advanced) setForm({ ...EMPTY, tools: t('skills.defaultTools'), license: t('skills.defaultLicense') })
              setAdvanced(value => !value)
            }}>{t('skills.advanced')}</Button>
          )}
        </div>
      </header>
      {installActorId === undefined && <p className={css.hint}>{t('skills.library.noSupervisor')}</p>}
      <div className={css.sources} data-skill-sources>
        <span className={css.sourcesLabel}>{t('skills.sources.label')}</span>
        <a href={SKILL_SOURCES.skillhub} target="_blank" rel="noopener noreferrer">{t('skills.sources.skillhub')}</a>
        <a href={SKILL_SOURCES.clawhub} target="_blank" rel="noopener noreferrer">{t('skills.sources.clawhub')}</a>
        <a href={SKILL_SOURCES.aiDesign} target="_blank" rel="noopener noreferrer">{t('skills.sources.aiDesign')}</a>
        <a href={SKILL_SOURCES.githubTopic} target="_blank" rel="noopener noreferrer">{t('skills.sources.githubTopic')}</a>
        <p>{t('skills.sources.caution')}</p>
      </div>
      {installOpen && installActorId !== undefined && (
        <CadreSkillInstallDialog
          projectId={projectId}
          actorSessionId={installActorId}
          onInstalled={load}
          openAdmin={() => { setInstallOpen(false); setAdminOpen(true) }}
          onClose={() => { setInstallOpen(false) }}
          t={t}
        />
      )}
      {isSupervisor && adminOpen && (
        <CadreSkillAdminDialog
          projectId={projectId}
          operatorSessionId={actor.sessionId}
          openSession={openSkillAdminSession}
          onClose={() => { setAdminOpen(false) }}
          t={t}
        />
      )}
      {isSupervisor && advanced && (
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
      {group(t('skills.group.builtin'), builtin, false)}
      {group(t('skills.group.installed'), installed, isSupervisor)}
    </section>
  )
}
