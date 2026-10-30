/**
 * DF-014 supervisor stall cards.
 *
 * Cards are driven by the host-governance task view, not local timers. A
 * project without a readable view is silent (no supervisor); a present view
 * error is visible with a retry. Cards are keyed by episodeId so polling
 * updates them in place.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterMember, CadreRosterState } from './CadreSidebar.tsx'
import {
  type CadreExecutionView,
  type CadreStallActionBase,
  type CadreStallActionResult,
  type CadreStallError,
  type CadreStallState,
  type CadreStallTaskView,
  type CadreStallThresholds,
  elapsedText,
  executionOf,
  executionText,
  isWriteGuardError,
  localTime,
  relativeTime,
  silenceText,
} from './cadre-stall.ts'
import css from './CadreStallCard.module.css'

/** Host-provided view and real action route callbacks for the supervisor card. */
export interface CadreStallCardInjected {
  hooks: {
    stall: HostObservable<CadreStallState>
    roster: HostObservable<CadreRosterState>
  }
  projectId?: string
  nudge(input: CadreStallActionBase): Promise<CadreStallActionResult>
  reassign(input: CadreStallActionBase & { readonly toSessionId: string; readonly reason: string }): Promise<CadreStallActionResult>
  cancel(input: CadreStallActionBase & { readonly reason: string }): Promise<CadreStallActionResult>
  escalate(input: CadreStallActionBase): Promise<CadreStallActionResult>
  refresh(): void
}

export type CadreStallCardProps = InjectFace<CadreStallCardInjected> & PropsLocale<'sidebar'> & {
  readonly sessionId: string
}

function requestFor(task: CadreStallTaskView, suffix: string): CadreStallActionBase {
  return {
    taskId: task.taskId,
    episodeId: task.episodeId,
    expectedVersion: task.version,
    idempotencyKey: `stall-${task.episodeId}-${suffix}-${String(Date.now())}`,
  }
}

function suggestionText(
  suggested: CadreStallTaskView['suggestedAction'],
  t: PropsLocale<'sidebar'>['t'],
): string {
  if (suggested === 'nudge') return t('stall.card.suggest.nudge')
  if (suggested === 'reassign') return t('stall.card.suggest.reassign')
  if (suggested === 'cancel') return t('stall.card.suggest.cancel')
  if (suggested === 'escalate') return t('stall.card.suggest.escalate')
  return ''
}

function cooldownLeft(task: CadreStallTaskView, cooldownMs: number): number {
  if (task.lastNudgedAt === null) return 0
  return Math.max(0, task.lastNudgedAt + cooldownMs - Date.now())
}

function errorText(
  result: { readonly code: string; readonly message: string },
  t: PropsLocale<'sidebar'>['t'],
): string {
  return t('stall.card.error', { code: result.code, message: result.message })
}

function roleText(role: string, t: PropsLocale<'sidebar'>['t']): string {
  return role === 'worker' ? t('stall.card.worker') : role
}

function basisKindText(
  kind: NonNullable<CadreStallTaskView['stallBasis']>['kind'],
  t: PropsLocale<'sidebar'>['t'],
): string {
  if (kind === 'model_generation') return t('stall.basis.model_generation')
  if (kind === 'tool_execution') return t('stall.basis.tool_execution')
  return t('stall.basis.no_events')
}

function targetsFrom(members: readonly CadreRosterMember[]): readonly CadreRosterMember[] {
  return members.filter(member => member.role === 'worker' && member.state !== 'departed')
}

/** Render the supervisor-only stall card list for one conversation. */
export function CadreStallCard({
  sessionId, projectId, t, useStall, useRoster, nudge, reassign, cancel, escalate, refresh,
}: CadreStallCardProps) {
  const member = useRoster(state => state.members.find(item => item.sessionId === sessionId))
  const members = useRoster(state => state.members)
  const project = useStall(state => projectId === undefined ? undefined : state.byProject.get(projectId))
  if (member?.role !== 'supervisor' || projectId === undefined) return null

  if (project?.status === 'error') {
    return (
      <div className={css.errorState} role="alert">
        <span>{t('stall.card.viewError', { message: project.error ?? t('stall.readFailed') })}</span>
        <Button variant="outline" size="sm" onClick={refresh}>{t('stall.retry')}</Button>
      </div>
    )
  }
  if (project === undefined || project.status === 'loading' || project.status === 'unavailable') return null

  const executions = project.tasks.flatMap((task) => {
    const execution = executionOf(task)
    return execution === null ? [] : [{ task, execution }]
  })
  const errors = project.tasks.flatMap(task => task.lastError === undefined || task.lastError === null
    ? []
    : [{ task, error: task.lastError }])
  // A stalled task is actionable only when it has no live turn; generation and
  // tool execution are progress, never a stall card.
  const stalled = project.tasks.filter(task => task.stallState === 'stalled' && executionOf(task) === null)
  const cards = [...new Map(stalled.map(task => [task.episodeId, task])).values()]
  if (cards.length === 0 && executions.length === 0 && errors.length === 0) return null

  return (
    <section className={css.stack} aria-label={t('stall.card.aria')}>
      {executions.map(({ task, execution }) => (
        <CadreExecutionRow key={`execution:${task.taskId}`} task={task} execution={execution} t={t} />
      ))}
      {errors.map(({ task, error }) => (
        <CadreErrorMessage
          key={`error:${task.taskId}:${error.code}:${error.at}`}
          taskId={task.taskId}
          title={task.title}
          error={error}
          t={t}
        />
      ))}
      {cards.map(task => (
        <CadreStallCardItem
          key={task.episodeId}
          t={t}
          task={task}
          stale={project.stale || task.stale}
          thresholds={project.thresholds}
          targets={targetsFrom(members)}
          nudge={nudge}
          reassign={reassign}
          cancel={cancel}
          escalate={escalate}
          refresh={refresh}
        />
      ))}
    </section>
  )
}

function CadreExecutionRow({
  task, execution, t,
}: {
  readonly task: CadreStallTaskView
  readonly execution: CadreExecutionView
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  return (
    <article className={css.executionRow} data-execution-state={execution.state} aria-label={t('stall.execution.aria')}>
      <div className={css.executionHead}>
        <span className={css.executionDot} aria-hidden="true" />
        <strong>{executionText(execution, t)}</strong>
        <span className={css.executionTask}>{task.title}</span>
      </div>
      <div className={css.executionMeta}>
        <span>{task.assigneeName}</span>
        {execution.firstTokenAt !== undefined && execution.firstTokenAt !== null && (
          <span>{t('stall.execution.firstToken', { time: localTime(execution.firstTokenAt, t) })}</span>
        )}
        {execution.heartbeatAt !== undefined && execution.heartbeatAt !== null && (
          <span>{t('stall.execution.heartbeat', { time: localTime(execution.heartbeatAt, t) })}</span>
        )}
        {execution.tokensSoFar !== undefined && execution.tokensSoFar !== null && (
          <span>{t('stall.execution.tokens', { count: execution.tokensSoFar })}</span>
        )}
        {task.inferred && <span className={css.degraded}>{t('stall.execution.inferred')}</span>}
      </div>
    </article>
  )
}

function CadreErrorMessage({
  taskId, title, error, t,
}: {
  readonly taskId: string
  readonly title: string
  readonly error: CadreStallError
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const guard = isWriteGuardError(error.code)
  return (
    <article className={guard ? css.writeGuard : css.lastError} role="alert" data-error-code={error.code}>
      <div className={css.errorHead}>
        <strong>{guard ? t('stall.writeGuard.title') : t('stall.lastError.title')}</strong>
        <span className={css.errorCode}>{error.code}</span>
      </div>
      <div className={css.errorTask}>{title} · {taskId}</div>
      <div className={css.errorMessage}>{error.message}</div>
      <div className={css.errorAt}>
        {t(guard ? 'stall.writeGuard.at' : 'stall.lastError.at', { time: localTime(error.at, t) })}
      </div>
      {guard && <div className={css.errorHint}>{t('stall.writeGuard.hint')}</div>}
    </article>
  )
}

function CadreStallCardItem({
  task, t, stale, thresholds, targets, nudge, reassign, cancel, escalate, refresh,
}: {
  readonly task: CadreStallTaskView
  readonly t: PropsLocale<'sidebar'>['t']
  readonly stale: boolean
  readonly thresholds: CadreStallThresholds
  readonly targets: readonly CadreRosterMember[]
  readonly nudge: CadreStallCardInjected['nudge']
  readonly reassign: CadreStallCardInjected['reassign']
  readonly cancel: CadreStallCardInjected['cancel']
  readonly escalate: CadreStallCardInjected['escalate']
  readonly refresh: () => void
}) {
  const [pending, setPending] = useState<'nudge' | 'escalate' | null>(null)
  const [modal, setModal] = useState<'reassign' | 'cancel' | null>(null)
  const [modalPending, setModalPending] = useState(false)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [internalActionsVisible, setInternalActionsVisible] = useState(false)
  const cooldown = cooldownLeft(task, thresholds.nudgeCooldownMs)
  const canNudge = !stale && task.capabilities.nudge && cooldown === 0
  const cooldownSeconds = Math.ceil(cooldown / 1000)
  const reasonRequired = reason.trim() === ''
  const targetReady = targets.some(item => item.sessionId === target && item.state === 'available')

  const run = async (kind: 'nudge' | 'escalate'): Promise<void> => {
    setPending(kind)
    setError(null)
    setNotice(null)
    try {
      const result = kind === 'nudge'
        ? await nudge(requestFor(task, 'nudge'))
        : await escalate(requestFor(task, 'escalate'))
      if (!result.ok) {
        setError(errorText(result, t))
        return
      }
      setNotice(kind === 'nudge' ? t('stall.card.notice.nudge') : t('stall.card.notice.escalate'))
      refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  const runReassign = async (): Promise<void> => {
    setModalPending(true)
    setError(null)
    try {
      const result = await reassign({
        ...requestFor(task, 'reassign'),
        toSessionId: target,
        reason: reason.trim(),
      })
      if (!result.ok) {
        setError(errorText(result, t))
        return
      }
      setModal(null)
      refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setModalPending(false)
    }
  }

  const runCancel = async (): Promise<void> => {
    setModalPending(true)
    setError(null)
    try {
      const result = await cancel({ ...requestFor(task, 'cancel'), reason: reason.trim() })
      if (!result.ok) {
        setError(errorText(result, t))
        return
      }
      setModal(null)
      refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setModalPending(false)
    }
  }

  return (
    <article className={css.card} data-episode-id={task.episodeId}>
      <div className={css.header}>
        <span className={css.warningDot} aria-hidden="true" />
        <strong>{t('stall.card.header', { silence: silenceText(task.silenceMs, t) })}</strong>
        <span className={css.tag}>{t('stall.card.taskTag')}</span>
      </div>
      <div className={css.title}>{task.title}</div>
      <div className={css.meta}>
        {t('stall.card.meta', {
          name: task.assigneeName,
          role: roleText(task.assigneeRole, t),
          activity: relativeTime(task.lastActivityAt, t),
        })}
      </div>
      {task.inferred && <div className={css.degraded}>{t('stall.execution.inferred')}</div>}
      {task.stallBasis !== null && (
        <div className={css.basis}>
          {t('stall.card.basis', {
            kind: basisKindText(task.stallBasis.kind, t),
            heartbeat: elapsedText(task.stallBasis.heartbeatAgeMs, t),
          })}
        </div>
      )}
      {suggestionText(task.suggestedAction, t) !== '' && (
        <div className={css.suggestion}>{suggestionText(task.suggestedAction, t)}</div>
      )}
      {stale && <div className={css.warning} role="status">{t('stall.card.stale')}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {notice !== null && <div className={css.notice} role="status">{notice}</div>}
      <div className={css.internalBar}>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={internalActionsVisible}
          onClick={() => { setInternalActionsVisible(visible => !visible) }}
        >
          {internalActionsVisible ? t('stall.card.internal.hide') : t('stall.card.internal.show')}
        </Button>
      </div>
      {internalActionsVisible && <div className={css.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={pending !== null || !canNudge}
          onClick={() => { void run('nudge') }}
        >
          {pending === 'nudge'
            ? t('stall.card.nudgePending')
            : cooldownSeconds > 0 ? t('stall.card.nudgeCooldown', { seconds: cooldownSeconds }) : t('stall.card.nudge')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null || stale || !task.capabilities.reassign}
          onClick={() => { setModal('reassign'); setTarget(''); setReason(''); setError(null) }}
        >
          {t('stall.card.reassign')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null || stale || !task.capabilities.cancel}
          onClick={() => { setModal('cancel'); setReason(''); setError(null) }}
        >
          {t('stall.card.cancel')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null || stale || !task.capabilities.escalate}
          onClick={() => { void run('escalate') }}
        >
          {pending === 'escalate' ? t('stall.card.escalatePending') : t('stall.card.escalate')}
        </Button>
      </div>}
      <Modal
        open={modal !== null}
        onClose={() => { if (!modalPending) setModal(null) }}
        title={modal === 'reassign' ? t('stall.card.reassignTitle') : t('stall.card.cancelTitle')}
        description={task.title}
        closeLabel={t('stall.card.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setModal(null) }}>{t('stall.card.cancelAction')}</Button>
            <Button
              variant="primary"
              disabled={modalPending || reasonRequired || (modal === 'reassign' && !targetReady)}
              onClick={() => { void (modal === 'reassign' ? runReassign() : runCancel()) }}
            >
              {modalPending
                ? t('stall.card.processing')
                : modal === 'reassign' ? t('stall.card.confirmReassign') : t('stall.card.confirmCancel')}
            </Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          {modal === 'reassign' && (
            <>
              <label htmlFor="cadre-stall-reassign-target">{t('stall.card.target')}</label>
              <select
                id="cadre-stall-reassign-target"
                value={target}
                onChange={(event) => { setTarget(event.target.value) }}
              >
                <option value="">{t('stall.card.chooseTarget')}</option>
                {targets.map(item => (
                  <option key={item.sessionId} value={item.sessionId} disabled={item.state !== 'available'}>
                    {t('stall.card.targetOption', {
                      name: item.displayName ?? item.sessionId,
                      role: item.description ?? t('stall.card.worker'),
                    })}
                    {item.state === 'available' ? '' : t('stall.card.targetUnavailable')}
                  </option>
                ))}
              </select>
              <p className={css.hint}>{t('stall.card.reassignHint')}</p>
            </>
          )}
          <label htmlFor="cadre-stall-reason">{t('stall.card.reason')}</label>
          <textarea
            id="cadre-stall-reason"
            rows={3}
            value={reason}
            placeholder={modal === 'reassign'
              ? t('stall.card.reassignPlaceholder')
              : t('stall.card.cancelPlaceholder')}
            onChange={(event) => { setReason(event.target.value) }}
          />
          {modal === 'cancel' && <p className={css.warning}>{t('stall.card.cancelWarning')}</p>}
          {error !== null && <p className={css.error} role="alert">{error}</p>}
        </div>
      </Modal>
    </article>
  )
}
