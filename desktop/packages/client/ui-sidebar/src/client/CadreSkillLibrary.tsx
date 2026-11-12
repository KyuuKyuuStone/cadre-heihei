/** Skill catalog and health with conversation-bound install and use actions. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterMember, CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import {
  fetchSkillCatalog,
  removeSkillFromLibrary,
  SkillOperationError,
  type CadreSkillEntry,
} from './CadreSkills.tsx'
import {
  bindSkillSession,
  fetchSkillHealth,
  SkillAdminError,
  type SkillHealth,
  type SkillHealthStatus,
} from './CadreSkillAdmin.ts'
import css from './CadreSkillLibrary.module.css'

export interface CadreSkillLibraryInjected {
  hooks: { roster: HostObservable<CadreRosterState>; sessions: HostObservable<CadreSessionsState> }
  projectOfSession(sessionId: string): string | undefined
  /** Fallback project for a session that belongs to no project; undefined when none exists. */
  defaultProjectId(): string | undefined
  openSession(sessionId: string): void
}

interface LibraryError {
  readonly code: string
  readonly message: string
  readonly remediation: string
  readonly recoverable: boolean
}

type Translator = PropsLocale<'sidebar'>['t']

const INSTALL_SKILL_ID = '__install__'
const BUILTIN_SOURCES = /^(builtin|internal|cadre)$/iu
const isBuiltin = (entry: CadreSkillEntry): boolean =>
  entry.origin === 'builtin' || (entry.origin === undefined && BUILTIN_SOURCES.test(entry.source.trim()))
const localizedDescription = (entry: CadreSkillEntry, t: Translator): string => {
  if (entry.id === 'ai-design' || entry.id === 'landing-page-design') return t('skills.desc.ai-design')
  return entry.description
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

const asError = (error: unknown, t: Translator): LibraryError => {
  if (error instanceof SkillOperationError) {
    const forbidden = error.code === 'SKILL_FORBIDDEN' || error.code === 'SKILL_ADMIN_FORBIDDEN'
    return {
      code: error.code,
      message: forbidden ? t('skills.admin.error.forbidden') : error.detail,
      remediation: error.remediation ?? t(forbidden ? 'skills.library.forbiddenRemediation' : 'skills.library.errorRemediation'),
      recoverable: true,
    }
  }
  return {
    code: 'SKILL_LIBRARY_LOAD_FAILED',
    message: t('skills.library.loadFailed'),
    remediation: t('skills.library.errorRemediation'),
    recoverable: true,
  }
}

const bindingErrorCode = (error: unknown): string =>
  error instanceof SkillAdminError ? error.code : 'SKILL_BIND_SESSION_FAILED'

function BindingErrorNotice({ code, t }: { readonly code: string; readonly t: Translator }) {
  let message = t('skills.bind.error.generic')
  let remediation = t('skills.bind.remediation.generic')
  if (code === 'SKILL_BIND_DELETE_FAILED') {
    message = t('skills.bind.error.deleteFailed')
    remediation = t('skills.bind.remediation.deleteFailed')
  } else if (code === 'SKILL_BIND_SESSION_FAILED') {
    message = t('skills.bind.error.sessionFailed')
    remediation = t('skills.bind.remediation.sessionFailed')
  } else if (code === 'SKILL_ADMIN_DELETE_UNSUPPORTED') {
    message = t('skills.bind.error.deleteUnsupported')
    remediation = t('skills.bind.remediation.deleteUnsupported')
  } else if (code === 'SKILL_PROJECT_REQUIRED') {
    message = t('skills.bind.error.projectRequired')
    remediation = t('skills.bind.remediation.projectRequired')
  } else if (code === 'SKILL_SESSION_OPEN_FAILED') {
    message = t('skills.bind.error.openFailed')
    remediation = t('skills.bind.remediation.openFailed')
  }
  return (
    <div className={css.bindError} role="alert">
      <span className={css.errorCode}>{code}</span>
      <p>{message}</p>
      <p>{remediation}</p>
    </div>
  )
}

const healthLabel = (status: SkillHealthStatus, t: Translator): string => {
  switch (status) {
    case 'ok': return t('skills.health.ok')
    case 'warning': return t('skills.health.warning')
    case 'error': return t('skills.health.error')
  }
}
const healthTone = (status: SkillHealthStatus): 'success' | 'warning' | 'danger' => {
  switch (status) {
    case 'ok': return 'success'
    case 'warning': return 'warning'
    case 'error': return 'danger'
  }
}

export function CadreSkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <span className={css.icon} style={{ width: size, height: size }} aria-hidden="true">✦</span>
}

export function CadreSkillLibraryPage({
  useRoster,
  useSessions,
  projectOfSession,
  defaultProjectId,
  openSession,
  t,
}: PropsRuntime<'sidebar'> & PropsLocale<'sidebar'> & InjectFace<CadreSkillLibraryInjected>) {
  const members = useRoster(state => state.members)
  const byId = useSessions(state => state.byId)
  const activeSessionId = Object.entries(byId)
    .sort(([, a], [, b]) => (b.retainedBy.mainView ?? 0) - (a.retainedBy.mainView ?? 0))
    .find(([, session]) => (session.retainedBy.mainView ?? 0) > 0)?.[0]
  const projectId = (activeSessionId === undefined ? undefined : projectOfSession(activeSessionId)) ?? defaultProjectId()
  const actorSessionId = actingSessionIdOf(members, projectId, activeSessionId, projectOfSession)
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [health, setHealth] = useState<SkillHealth | undefined>()
  const [healthFailure, setHealthFailure] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LibraryError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [bindingTarget, setBindingTarget] = useState<string | null>(null)
  const [bindingErrors, setBindingErrors] = useState<Readonly<Record<string, string>>>({})
  const catalogGeneration = useRef(0)
  const scopeGeneration = useRef(0)

  useEffect(() => {
    setEntries([])
    setBusy(false)
    setError(null)
    setNotice(null)
    setBindingTarget(null)
    setBindingErrors({})
    return () => { scopeGeneration.current += 1 }
  }, [actorSessionId, projectId])

  const load = useCallback(async () => {
    if (projectId === undefined || actorSessionId === undefined) return
    const scope = scopeGeneration.current
    const generation = ++catalogGeneration.current
    const current = () => generation === catalogGeneration.current && scope === scopeGeneration.current
    setBusy(true)
    setError(null)
    try {
      const rows = await fetchSkillCatalog(projectId, actorSessionId, actorSessionId, navigator.language)
      if (current()) setEntries(rows)
    } catch (cause) {
      if (current()) setError(asError(cause, t))
    } finally {
      if (current()) setBusy(false)
    }
  }, [actorSessionId, projectId, t])

  useEffect(() => {
    void load()
    return () => { catalogGeneration.current += 1 }
  }, [load])
  useEffect(() => {
    if (projectId === undefined || actorSessionId === undefined) return
    let cancelled = false
    setHealth(undefined)
    setHealthFailure(null)
    void fetchSkillHealth(projectId, actorSessionId).then(result => {
      if (cancelled) return
      if (result === undefined) setHealthFailure(200)
      else setHealth(result)
    }).catch((cause: unknown) => {
      if (!cancelled) setHealthFailure(cause instanceof SkillAdminError && cause.code === 'SKILL_ADMIN_FORBIDDEN' ? 403 : 500)
    })
    return () => { cancelled = true }
  }, [actorSessionId, projectId])

  if (projectId === undefined || actorSessionId === undefined) {
    return (
      <section className={css.page}>
        <h1>{t('skills.library.title')}</h1>
        <p>{t('skills.library.readOnly')}</p>
      </section>
    )
  }

  const openSkillConversation = async (skillId: string, skillName: string): Promise<void> => {
    if (bindingTarget !== null) return
    const scope = scopeGeneration.current
    const current = () => scope === scopeGeneration.current
    setBindingTarget(skillId)
    setBindingErrors(current => {
      const next = { ...current }
      delete next[skillId]
      return next
    })
    let sessionId: string | undefined
    try {
      const binding = await bindSkillSession(projectId, skillId, skillName)
      if (current()) sessionId = binding.sessionId
    } catch (cause) {
      if (current()) setBindingErrors(existing => ({ ...existing, [skillId]: bindingErrorCode(cause) }))
      return
    } finally {
      if (current()) setBindingTarget(null)
    }
    if (sessionId === undefined || !current()) return
    try {
      openSession(sessionId)
    } catch {
      if (current()) setBindingErrors(existing => ({ ...existing, [skillId]: 'SKILL_SESSION_OPEN_FAILED' }))
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('skills.confirmRemove', { id }))) return
    const scope = scopeGeneration.current
    const current = () => scope === scopeGeneration.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await removeSkillFromLibrary(projectId, actorSessionId, id)
      if (!current()) return
      setNotice(t('skills.notice.removed'))
      await load()
    } catch (cause) {
      if (current()) setError(asError(cause, t))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const group = (title: string, rows: readonly CadreSkillEntry[], removable: boolean) => (
    <section className={css.group} key={title}>
      <h2>{title}</h2>
      {rows.length === 0
        ? <p className={css.groupEmpty}>{t('skills.library.groupEmpty')}</p>
        : (
          <div className={css.list}>
            {rows.map(entry => {
              const packHealth = health?.items.find(item => item.packId === entry.id)
              const healthUnavailable = healthFailure !== null || (health !== undefined && packHealth === undefined)
              const healthState = health === undefined || healthFailure !== null || packHealth === undefined ? undefined : packHealth.status
              const binding = bindingTarget === entry.id
              const bindingError = bindingErrors[entry.id]
              return (
                <article className={css.card} key={entry.id} data-skill-id={entry.id}>
                  <div className={css.cardHead}>
                    <span className={css.cardName}>{entry.name}</span>
                    {healthState === undefined
                      ? <Tag tone="neutral">{t(healthUnavailable ? 'skills.health.unavailableTag' : 'skills.health.loading')}</Tag>
                      : <Tag tone={healthTone(healthState)}>{healthLabel(healthState, t)}</Tag>}
                    {entry.selected && <span className={css.selected}>{t('skills.selected')}</span>}
                  </div>
                  <p className={css.cardDescription}>{localizedDescription(entry, t)}</p>
                  <div className={css.cardBody}>
                    <div className={css.meta}>
                      <span>{entry.roles.join(' / ')}</span>
                      <span>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
                      <span>{entry.tools.join(', ') || t('skills.toolsNone')}</span>
                      {entry.author !== undefined && <span>{t('skills.author', { author: entry.author })}</span>}
                      <span>{t('skills.licenseLabel', { license: entry.license })}</span>
                    </div>
                    {healthUnavailable && <p className={css.healthFallback}>{t('skills.health.unavailable')}</p>}
                    {packHealth !== undefined && packHealth.issues.length > 0 && healthFailure === null && (
                      <details className={css.healthIssues}>
                        <summary>{t('skills.health.issueCount', { count: String(packHealth.issues.length) })}</summary>
                        <div className={css.issueList}>
                          {packHealth.issues.map(issue => (
                            <div className={css.issueItem} key={`${issue.code}:${issue.field ?? ''}:${issue.message}`}>
                              <span className={css.issueCode}>{issue.code}</span>
                              <p className={css.issueMessage}>{issue.message}</p>
                              <p className={css.issueRemediation}>{issue.remediation}</p>
                              {issue.field !== undefined && <span className={css.issueField}>{t('skills.health.field', { field: issue.field })}</span>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <div className={css.cardActions}>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || bindingTarget !== null}
                      onClick={() => { void openSkillConversation(entry.id, entry.name) }}
                    >
                      {binding ? t('skills.library.openingConversation') : t('skills.library.useConversation')}
                    </Button>
                    {removable && <Button variant="ghost" size="sm" disabled={busy || bindingTarget !== null} onClick={() => { void remove(entry.id) }}>{t('skills.remove')}</Button>}
                  </div>
                  {bindingError !== undefined && <BindingErrorNotice code={bindingError} t={t} />}
                </article>
              )
            })}
          </div>
        )}
    </section>
  )

  const builtin = entries.filter(isBuiltin)
  const installed = entries.filter(entry => !isBuiltin(entry))
  return (
    <section className={css.page}>
      <header className={css.header}>
        <div>
          <h1>{t('skills.library.title')}</h1>
          <p>{t('skills.library.description')}</p>
        </div>
        <div className={css.headerActions}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || bindingTarget !== null}
            onClick={() => { void openSkillConversation(INSTALL_SKILL_ID, t('skills.library.installConversation')) }}
          >
            {bindingTarget === INSTALL_SKILL_ID ? t('skills.library.openingConversation') : t('skills.library.installConversation')}
          </Button>
        </div>
      </header>
      {bindingErrors[INSTALL_SKILL_ID] !== undefined && <BindingErrorNotice code={bindingErrors[INSTALL_SKILL_ID]} t={t} />}
      {error !== null && (
        <div className={css.errorPanel} role="alert">
          <span className={css.errorCode}>{error.code}</span>
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
