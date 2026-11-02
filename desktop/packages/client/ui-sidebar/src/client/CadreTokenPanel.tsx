/** Sidebar token-usage entry and its session/task snapshot panel. */
import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import type { CadreTokenInjected } from './CadreTokenTypes.ts'
import css from './CadreTokenPanel.module.css'

interface RoundUsage {
  readonly round: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

interface Snapshot {
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly rounds: readonly RoundUsage[]
  readonly recent: readonly RoundUsage[]
}

const TASK_BUDGET = 30_000
const ROUND_BUDGET = 8_000
const WARN = 0.8

function pct(value: number, budget: number): number {
  return Math.min(100, Math.max(0, Math.round((value / budget) * 100)))
}

function tokenText(value: number, t: PropsLocale<'sidebar'>['t']): string {
  return value >= 1_000
    ? t('token.thousands', { value: (value / 1_000).toFixed(value >= 10_000 ? 0 : 1) })
    : String(value)
}

function loadSnapshot(
  projectId: string,
  actorSessionId: string,
  sessionId: string,
  taskId: string | undefined,
): Promise<Snapshot> {
  return fetch('/cadre/token/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      actorSessionId,
      ...(taskId === undefined || taskId === '' ? { sessionId } : { taskId }),
    }),
  }).then(async (response) => {
    const payload = await response.json() as { ok?: boolean; snapshot?: Snapshot; message?: string }
    if (!response.ok || payload.snapshot === undefined) {
      throw new Error(payload.message ?? 'TOKEN_SNAPSHOT_FAILED')
    }
    return payload.snapshot
  })
}

/** Footer action opening the panel for the Session retained by the main view. */
export function CadreTokenButton({
  wide, useSessions, useRoster, projectOfSession, openToken, t,
}: {
  readonly wide: boolean
  readonly useSessions: <T>(selector: (state: {
    readonly byId: Readonly<Record<string, { readonly retainedBy?: { readonly mainView?: number } }>>
  }) => T) => T
  readonly useRoster: <T>(selector: (state: CadreRosterState) => T) => T
  readonly projectOfSession: (sessionId: string) => string | undefined
  readonly openToken: (sessionId: string, projectId: string, label: string) => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session.retainedBy?.mainView ?? 0) > 0)?.[0])
  const member = useRoster(state => state.members.find(item => item.sessionId === activeSessionId))
  const projectId = activeSessionId === undefined ? undefined : projectOfSession(activeSessionId)
  if (activeSessionId === undefined || member === undefined || projectId === undefined) return null
  return (
    <button
      type="button"
      className={wide ? css.entry : `${css.entry} ${css.rail}`}
      onClick={() => { openToken(activeSessionId, projectId, member.displayName ?? member.sessionId) }}
      title={t('token.open')}
      aria-label={t('token.open')}
    >
      <span aria-hidden="true">∑</span>
      {wide && <span className={css.entryLabel}>{t('token.open')}</span>}
    </button>
  )
}

/** Session snapshot with optional supervisor task lookup and budget guidance. */
export function CadreTokenPanel({
  useTokenRequest, useRoster, closeToken, t,
}: InjectFace<CadreTokenInjected> & PropsLocale<'sidebar'>) {
  const request = useTokenRequest(state => state)
  const member = useRoster(state => request === null
    ? undefined
    : state.members.find(item => item.sessionId === request.sessionId))
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [taskId, setTaskId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const supervisor = member?.role === 'supervisor' && member.state !== 'departed'
  const compact = (value: number): string => tokenText(value, t)

  useEffect(() => {
    setSnapshot(null)
    setError(null)
    setTaskId('')
    if (request === null) return
    let alive = true
    setLoading(true)
    void loadSnapshot(request.projectId, request.sessionId, request.sessionId, undefined)
      .then((next) => { if (alive) setSnapshot(next) })
      .catch(() => { if (alive) setError(t('token.error')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [request?.token])

  const reload = (nextTaskId: string | undefined): void => {
    if (request === null) return
    setError(null)
    setLoading(true)
    void loadSnapshot(request.projectId, request.sessionId, request.sessionId, nextTaskId)
      .then((next) => { setSnapshot(next) })
      .catch(() => { setError(t('token.error')) })
      .finally(() => { setLoading(false) })
  }

  const totals = useMemo(() => {
    const lastRound = snapshot?.recent.at(-1)?.totalTokens ?? 0
    return {
      taskPct: pct(snapshot?.totalTokens ?? 0, TASK_BUDGET),
      roundPct: pct(lastRound, ROUND_BUDGET),
      taskTotal: snapshot?.totalTokens ?? 0,
      roundTotal: lastRound,
    }
  }, [snapshot])
  if (request === null) return null
  const maxRound = Math.max(1, ...(snapshot?.recent.map(round => round.totalTokens) ?? []))
  const warn = totals.taskPct >= WARN * 100 || totals.roundPct >= WARN * 100

  return (
    <div className={css.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeToken() }}>
      <section className={css.panel} role="dialog" aria-modal="true" aria-label={t('token.title')}>
        <header className={css.header}>
          <div>
            <h2 className={css.title}>{t('token.title')}</h2>
            <p className={css.subtitle}>{request.label}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={closeToken} aria-label={t('token.close')}>×</Button>
        </header>

        {loading && <p className={css.muted}>{t('token.loading')}</p>}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        {!loading && error === null && snapshot !== null && snapshot.totalTokens === 0 && snapshot.rounds.length === 0 && (
          <p className={css.muted}>{t('token.empty')}</p>
        )}
        {snapshot !== null && (snapshot.totalTokens > 0 || snapshot.rounds.length > 0) && (
          <>
            <div className={css.totals}>
              <div className={css.totalMain}>
                <span className={css.totalLabel}>{t('token.total')}</span>
                <strong className={css.totalValue}>{snapshot.totalTokens.toLocaleString()}</strong>
              </div>
              <div className={css.totalGrid}>
                <span>{t('token.prompt')}<b>{compact(snapshot.promptTokens)}</b></span>
                <span>{t('token.cached')}<b>{compact(snapshot.cachedTokens)}</b></span>
                <span>{t('token.completion')}<b>{compact(snapshot.completionTokens)}</b></span>
                <span>{t('token.rounds')}<b>{snapshot.rounds.length}</b></span>
              </div>
            </div>

            <div className={css.budgets}>
              <div className={css.budget}>
                <span>{t('token.taskBudget', { used: compact(totals.taskTotal), budget: '30k' })}</span>
                <b>{totals.taskPct}%</b>
                <div className={css.track}><div className={css.fill} style={{ width: `${totals.taskPct}%` }} /></div>
              </div>
              <div className={css.budget}>
                <span>{t('token.roundBudget', { used: compact(totals.roundTotal), budget: '8k' })}</span>
                <b>{totals.roundPct}%</b>
                <div className={css.track}><div className={css.fill} style={{ width: `${totals.roundPct}%` }} /></div>
              </div>
            </div>

            {warn && (
              <div className={css.warning} role="status">
                <strong>{t('token.warn.title')}</strong>
                <ul>
                  <li>{t('token.warn.compact')}</li>
                  <li>{t('token.warn.newSession')}</li>
                  <li>{t('token.warn.split')}</li>
                </ul>
              </div>
            )}

            <div className={css.recent}>
              <h3>{t('token.recent')}</h3>
              {snapshot.recent.length === 0
                ? <p className={css.muted}>{t('token.empty')}</p>
                : snapshot.recent.map(round => (
                  <div className={css.round} key={round.round}>
                    <span>{t('token.round', { round: round.round })}</span>
                    <div className={css.track}><div className={css.fill} style={{ width: `${Math.round(round.totalTokens / maxRound * 100)}%` }} /></div>
                    <b>{compact(round.totalTokens)}</b>
                  </div>
                ))}
            </div>
          </>
        )}

        {supervisor && (
          <form
            className={css.taskQuery}
            onSubmit={(event) => { event.preventDefault(); reload(taskId.trim() === '' ? undefined : taskId.trim()) }}
          >
            <label>
              {t('token.taskId')}
              <input value={taskId} onChange={(event) => { setTaskId(event.target.value) }} placeholder={t('token.taskId.placeholder')} />
            </label>
            <Button type="submit" size="sm" disabled={loading}>{t('token.query')}</Button>
          </form>
        )}
        {member !== undefined && (
          <Tag className={css.role}>{supervisor ? t('token.scope.supervisor') : t('token.scope.self')}</Tag>
        )}
      </section>
    </div>
  )
}
