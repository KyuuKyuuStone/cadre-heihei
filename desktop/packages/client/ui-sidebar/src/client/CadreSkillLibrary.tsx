/**
 * Global skill library: the catalog stays readable in every session, while
 * optional health and install results retain actionable remediation.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterMember, CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import {
  addSkillToLibrary,
  fetchSkillCatalog,
  installSkillAny,
  removeSkillFromLibrary,
  SkillOperationError,
  type CadreInstallAnyResult,
  type CadreSkillEntry,
} from './CadreSkills.tsx'
import {
  fetchSkillHealth,
  type SkillHealth,
  type SkillHealthIssue,
  type SkillHealthStatus,
} from './CadreSkillAdmin.ts'
import css from './CadreSkillLibrary.module.css'

export interface CadreSkillLibraryInjected {
  hooks: { roster: HostObservable<CadreRosterState>; sessions: HostObservable<CadreSessionsState> }
  projectOfSession(sessionId: string): string | undefined
  /** Fallback project for a session that belongs to no project; undefined when none exists. */
  defaultProjectId(): string | undefined
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

interface LibraryError {
  readonly code: string
  readonly message: string
  readonly remediation: string
  readonly recoverable: boolean
}

type Translator = PropsLocale<'sidebar'>['t']

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
const localizedDescription = (entry: CadreSkillEntry, t: Translator): string => {
  if (entry.id === 'ai-design' || entry.id === 'landing-page-design') return t('skills.desc.ai-design')
  return entry.description
}
const skillHref = (entry: CadreSkillEntry): string => {
  const homepage = entry.homepage?.trim() ?? ''
  return homepage !== '' ? homepage : entry.source.trim()
}

/** Resolve the foreground session used by the existing project-scoped skill IPC. */
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

const remediationOf = (code: string, t: Translator): string => {
  switch (code) {
    case 'SKILL_PROJECT_REQUIRED': return t('skills.remediation.projectRequired')
    case 'SKILL_ADMIN_FORBIDDEN':
    case 'SKILL_FORBIDDEN': return t('skills.remediation.forbidden')
    case 'SKILL_CONFIRM_REQUIRED': return t('skills.remediation.confirmRequired')
    case 'SKILL_NOT_FOUND': return t('skills.remediation.notFound')
    case 'SKILL_EXISTS': return t('skills.remediation.exists')
    case 'SKILL_BUILTIN_READONLY': return t('skills.remediation.builtin')
    case 'SKILL_INVALID': return t('skills.remediation.invalid')
    case 'SKILL_SEARCH_UNAVAILABLE': return t('skills.remediation.searchUnavailable')
    case 'SKILL_URL_FETCH_FAILED': return t('skills.remediation.urlFetch')
    case 'SKILL_WRITE_FAILED': return t('skills.remediation.write')
    case 'SKILL_ADMIN_PLAN_EXPIRED':
    case 'SKILL_ADMIN_TOKEN_INVALID': return t('skills.remediation.plan')
    default: return t('skills.remediation.generic')
  }
}

const libraryError = (cause: unknown, t: Translator): LibraryError => {
  if (cause instanceof SkillOperationError) {
    const forbidden = cause.code === 'SKILL_FORBIDDEN' || cause.code === 'SKILL_ADMIN_FORBIDDEN'
    return {
      code: cause.code,
      message: forbidden ? t('skills.admin.error.forbidden') : cause.detail,
      remediation: cause.remediation ?? remediationOf(cause.code, t),
      recoverable: true,
    }
  }
  const detail = cause instanceof Error ? cause.message : String(cause)
  const matched = /^([A-Z][A-Z0-9_]+) · /u.exec(detail)
  const code = matched?.[1] ?? 'SKILL_UNKNOWN'
  const forbidden = code === 'SKILL_FORBIDDEN' || code === 'SKILL_ADMIN_FORBIDDEN'
  return {
    code,
    message: forbidden ? t('skills.admin.error.forbidden') : matched === null ? detail : detail.slice(matched[0].length),
    remediation: remediationOf(code, t),
    recoverable: true,
  }
}

const inputError = (message: string, t: Translator): LibraryError => ({
  code: 'SKILL_INVALID', message, remediation: remediationOf('SKILL_INVALID', t), recoverable: false,
})

const healthTone = (status: SkillHealthStatus): 'success' | 'warning' | 'danger' => {
  switch (status) {
    case 'ok': return 'success'
    case 'warning': return 'warning'
    case 'error': return 'danger'
  }
}

const healthLabel = (status: SkillHealthStatus, t: Translator): string => {
  switch (status) {
    case 'ok': return t('skills.health.ok')
    case 'warning': return t('skills.health.warning')
    case 'error': return t('skills.health.error')
  }
}

function CopyCommand({ command, label, t }: { command: string; label: string; t: Translator }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async (): Promise<void> => {
    setCopied(false)
    setFailed(false)
    const accepted = await writeClipboard(command)
    if (accepted) setCopied(true)
    else setFailed(true)
  }
  return (
    <div className={css.commandRow}>
      <div className={css.commandText}>
        <span className={css.commandLabel}>{label}</span>
        <code>{command}</code>
        {failed && <span className={css.copyFailed} role="status">{t('skills.commands.copyFailed')}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={() => { void copy() }}>
        {copied ? t('skills.commands.copied') : t('skills.commands.copy')}
      </Button>
    </div>
  )
}

function IssueList({ issues, t }: { issues: readonly SkillHealthIssue[]; t: Translator }) {
  return (
    <ul className={css.issues}>
      {issues.map(issue => (
        <li key={`${issue.code}:${issue.field ?? ''}`}>
          <code>{issue.code}</code>
          {issue.field !== undefined && <span>{t('skills.health.field', { field: issue.field })}</span>}
          <p>{issue.message}</p>
          <p className={css.remediation}>{issue.remediation}</p>
        </li>
      ))}
    </ul>
  )
}

const warningIssue = (code: string, t: Translator): SkillHealthIssue => {
  switch (code) {
    case 'missing-license': return {
      code, message: t('skills.warning.missing-license.message'), remediation: t('skills.warning.missing-license.remediation'),
    }
    case 'missing-hash': return {
      code, message: t('skills.warning.missing-hash.message'), remediation: t('skills.warning.missing-hash.remediation'),
    }
    case 'unknown-source': return {
      code, message: t('skills.warning.unknown-source.message'), remediation: t('skills.warning.unknown-source.remediation'),
    }
    default: return {
      code, message: t('skills.warning.unknown.message'), remediation: t('skills.warning.unknown.remediation'),
    }
  }
}

function InstallResult({ result, t }: { result: CadreInstallAnyResult; t: Translator }) {
  const issues = result.warnings.map(code => warningIssue(code, t))
  if (result.installed) {
    if (issues.length === 0) return null
    return (
      <section className={css.installResult} data-skill-install-warnings>
        <h3>{t('skills.install.warningsTitle')}</h3>
        <IssueList issues={issues} t={t} />
      </section>
    )
  }
  const command = result.kind === 'package'
    ? t('skills.commands.confirmPackage', { target: JSON.stringify(result.target) })
    : t('skills.commands.confirmUrl', { target: JSON.stringify(result.target) })
  return (
    <section className={css.installResult} data-skill-install-confirmation>
      <h3>{t('skills.install.pendingTitle')}</h3>
      <p>{t('skills.install.pendingDescription')}</p>
      <h4>{t('skills.install.previewTitle')}</h4>
      <dl className={css.preview}>
        <div><dt>{t('skills.field.name')}</dt><dd>{result.preview.name}</dd></div>
        <div><dt>{t('skills.admin.plan.source')}</dt><dd>{result.preview.source}</dd></div>
        <div><dt>{t('skills.admin.plan.license')}</dt><dd>{result.preview.license}</dd></div>
        {result.preview.author !== undefined && <div><dt>{t('skills.admin.plan.author')}</dt><dd>{result.preview.author}</dd></div>}
        <div><dt>{t('skills.admin.plan.hash')}</dt><dd>{t(result.preview.hasHash ? 'skills.install.hashPresent' : 'skills.install.hashMissing')}</dd></div>
      </dl>
      <IssueList issues={issues} t={t} />
      <CopyCommand command={command} label={t('skills.commands.confirmLabel')} t={t} />
    </section>
  )
}

/** Sidebar icon for the global skill library. */
export function CadreSkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <span className={css.icon} style={{ width: size, height: size }} aria-hidden="true">✦</span>
}

/** Global panel listing built-in and installed skills. */
export function CadreSkillLibraryPage({
  useRoster, useSessions, projectOfSession, defaultProjectId, t,
}: PropsRuntime<'main'> & InjectFace<CadreSkillLibraryInjected> & PropsLocale<'sidebar'>) {
  const members = useRoster(state => state.members)
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session.retainedBy.mainView ?? 0) > 0)?.[0])
  const sessionProjectId = activeSessionId === undefined ? undefined : projectOfSession(activeSessionId)
  const projectId = sessionProjectId ?? defaultProjectId()
  const actorSessionId = actingSessionIdOf(members, projectId, activeSessionId, projectOfSession)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [health, setHealth] = useState<SkillHealth | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installText, setInstallText] = useState('')
  const [installResult, setInstallResult] = useState<CadreInstallAnyResult | null>(null)
  const [error, setError] = useState<LibraryError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState<ManualState>(EMPTY)
  const [tokenManual, setTokenManual] = useState(false)

  const load = useCallback(async () => {
    if (actorSessionId === undefined || projectId === undefined) return
    setBusy(true)
    setError(null)
    setHealth(undefined)
    void fetchSkillHealth(projectId, actorSessionId)
      .then(result => { setHealth(result ?? null) })
      .catch(() => { setHealth(null) })
    try {
      setEntries(await fetchSkillCatalog(projectId, actorSessionId, actorSessionId, navigator.language))
    } catch (cause) {
      setError(libraryError(cause, t))
    } finally {
      setBusy(false)
    }
  }, [actorSessionId, projectId, t])

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
      setError(inputError(t('skills.error.id'), t))
      return
    }
    if (form.name.trim() === '' || form.content.trim() === '' || form.roles.length === 0) {
      setError(inputError(t('skills.error.required'), t))
      return
    }
    if (!/^\d+$/u.test(form.tokenEstimate)) {
      setError(inputError(t('skills.error.tokens'), t))
      return
    }
    if (entries.some(entry => entry.id === form.id && isBuiltin(entry))) {
      setError(inputError(t('skills.error.builtin'), t))
      return
    }
    if (entries.some(entry => entry.id === form.id)) {
      setError(inputError(t('skills.error.exists'), t))
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
      setError(libraryError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const install = async (): Promise<void> => {
    const text = installText.trim()
    if (text === '') {
      setError(inputError(t('skills.install.empty'), t))
      return
    }
    setBusy(true)
    setInstalling(true)
    setError(null)
    setNotice(null)
    setInstallResult(null)
    try {
      const result = await installSkillAny(projectId, actorSessionId, text)
      setInstallResult(result)
      if (result.installed) {
        setInstallText('')
        setNotice(t('skills.install.doneAny', {
          target: result.target,
          kind: t(result.kind === 'package' ? 'skills.install.kindPackage' : 'skills.install.kindUrl'),
        }))
        await load()
      }
    } catch (cause) {
      setError({ ...libraryError(cause, t), recoverable: false })
    } finally {
      setInstalling(false)
      setBusy(false)
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
      setError(libraryError(cause, t))
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
            {rows.map(entry => {
              const packHealth = health?.items.find(item => item.packId === entry.id)
              return (
                <li key={entry.id} className={css.card}>
                  <div className={css.cardHead}>
                    <strong>{entry.name}</strong>
                    {entry.selected && <span className={css.selected}>{t('skills.selected')}</span>}
                    {packHealth !== undefined
                      ? <Tag tone={healthTone(packHealth.status)}>{healthLabel(packHealth.status, t)}</Tag>
                      : <Tag tone="neutral">{t(health === undefined ? 'skills.health.loading' : 'skills.health.unavailableTag')}</Tag>}
                  </div>
                  <p>{localizedDescription(entry, t)}</p>
                  {packHealth !== undefined && packHealth.issues.length > 0 && (
                    <details className={css.healthIssues}>
                      <summary>{t('skills.health.issueCount', { count: String(packHealth.issues.length) })}</summary>
                      <IssueList issues={packHealth.issues} t={t} />
                    </details>
                  )}
                  {health !== undefined && packHealth === undefined && (
                    <div className={css.healthFallback}>
                      <span>{t('skills.health.unavailable')}</span>
                      <CopyCommand
                        command={t('skills.commands.checkPack', { id: JSON.stringify(entry.id) })}
                        label={t('skills.commands.checkPackLabel')}
                        t={t}
                      />
                    </div>
                  )}
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
              )
            })}
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
        </div>
        <div className={css.commands} data-skill-commands>
          <CopyCommand command={t('skills.commands.find')} label={t('skills.commands.findLabel')} t={t} />
          <CopyCommand command={t('skills.commands.install')} label={t('skills.commands.installLabel')} t={t} />
          <CopyCommand command={t('skills.commands.create')} label={t('skills.commands.createLabel')} t={t} />
          <CopyCommand command={t('skills.commands.check')} label={t('skills.commands.checkLabel')} t={t} />
        </div>
        <div className={css.directInstall}>
          <label>{t('skills.install.source')}
            <Input value={installText} disabled={busy} placeholder={t('skills.install.placeholder')}
              onChange={(event) => {
                setInstallText(event.target.value)
                setInstallResult(null)
              }} />
          </label>
          <Button variant="primary" disabled={busy} onClick={() => { void install() }}>
            {installing ? t('skills.install.busy') : t('skills.install.action')}
          </Button>
        </div>
        <p className={css.hint}>{t('skills.install.hint')}</p>
        {installResult !== null && <InstallResult result={installResult} t={t} />}
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
      {error !== null && (
        <div className={css.errorPanel} role="alert">
          <code className={css.errorCode}>{error.code}</code>
          <p className={css.error}>{error.message}</p>
          <p className={css.remediation}>{error.remediation}</p>
          {error.recoverable && (
            <>
              <p>{t('skills.library.errorHint')}</p>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load() }}>
                {t('skills.library.retry')}
              </Button>
            </>
          )}
        </div>
      )}
      {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      {entries.length === 0 && error === null && (
        <p className={css.emptyState}>{t(busy ? 'skills.library.loading' : 'skills.library.empty')}</p>
      )}
      {entries.length > 0 && group(t('skills.group.builtin'), builtin, false)}
      {entries.length > 0 && group(t('skills.group.installed'), installed, true)}
    </section>
  )
}
