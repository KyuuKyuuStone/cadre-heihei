/**
 * Global installed-skill library. It is separate from a member's selection:
 * this page installs/removes packs, while the member picker only chooses.
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
import css from './CadreSkillLibrary.module.css'

export interface CadreSkillLibraryInjected {
  hooks: { roster: HostObservable<CadreRosterState>; sessions: HostObservable<CadreSessionsState> }
  projectOfSession(sessionId: string): string | undefined
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

/** Sidebar icon for the global skill library. */
export function CadreSkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <span className={css.icon} style={{ width: size, height: size }} aria-hidden="true">✦</span>
}

/** Global panel listing installed skill packs and their installer. */
export function CadreSkillLibraryPage({
  useRoster, useSessions, projectOfSession, t,
}: PropsRuntime<'main'> & InjectFace<CadreSkillLibraryInjected> & PropsLocale<'sidebar'>) {
  const members = useRoster(state => state.members)
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session.retainedBy.mainView ?? 0) > 0)?.[0])
  const actor = members.find(member => member.sessionId === activeSessionId)
  const projectId = actor === undefined ? undefined : projectOfSession(actor.sessionId)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [form, setForm] = useState<ManualState>(EMPTY)
  const [tokenManual, setTokenManual] = useState(false)

  const load = useCallback(async () => {
    if (actor?.role !== 'supervisor' || projectId === undefined) return
    setBusy(true)
    setError(null)
    try {
      setEntries(await fetchSkillCatalog(projectId, actor.sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [actor?.role, actor?.sessionId, projectId])

  useEffect(() => { void load() }, [load])

  if (actor?.role !== 'supervisor' || projectId === undefined) {
    return (
      <section className={css.page} data-skill-library>
        <h1>{t('skills.library.title')}</h1>
        <p>{t('skills.library.readOnly')}</p>
      </section>
    )
  }

  const add = async (): Promise<void> => {
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
    if (entries.some(entry => entry.id === form.id) && !overwrite) {
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
        overwrite,
      })
      setAdding(false)
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

  return (
    <section className={css.page} data-skill-library>
      <header className={css.header}>
        <div>
          <h1>{t('skills.library.title')}</h1>
          <p>{t('skills.library.description')}</p>
        </div>
        <div className={css.actions}>
          <Button variant="outline" disabled title={t('skills.library.marketSoon')}>{t('skills.market')}</Button>
          <Button variant="primary" onClick={() => {
            setForm({ ...EMPTY, tools: t('skills.defaultTools'), license: t('skills.defaultLicense') })
            setTokenManual(false)
            setOverwrite(false)
            setAdding(value => !value)
            setError(null)
          }}>{t('skills.add')}</Button>
        </div>
      </header>
      {adding && (
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
              <textarea className={css.textarea} value={form.content} rows={7} disabled={busy}
                onChange={(event) => {
                  const content = event.target.value
                  setForm({
                    ...form,
                    content,
                    ...(tokenManual ? {} : { tokenEstimate: String(Math.ceil(content.length / 4)) }),
                  })
                }} />
            </label>
            <Checkbox checked={overwrite} label={t('skills.overwrite')} disabled={busy} onChange={setOverwrite} />
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void add() }}>{t('skills.addSave')}</Button>
          </div>
        </div>
      )}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      {entries.length === 0
        ? (
          <div className={css.empty}>
            <p>{t('skills.empty')}</p>
            <code>{t('skills.installDir')}</code>
          </div>
        )
        : (
          <ul className={css.list}>
            {entries.map(entry => (
              <li key={entry.id} className={css.card}>
                <div className={css.cardHead}>
                  <strong>{entry.name}</strong>
                  <span className={css.id}>{entry.id}</span>
                </div>
                <p>{entry.description}</p>
                <div className={css.meta}>
                  <span>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
                  <span>{entry.roles.join(' / ')}</span>
                  <span>{entry.license}</span>
                  <span>{entry.source}</span>
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => { void remove(entry.id) }}>{t('skills.remove')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
