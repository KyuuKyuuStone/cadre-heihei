/**
 * Cadre contributions that live on the official sidebar rows.
 *
 * The project (workspace) row gets the three-way ＋ menu; the read-only 台账
 * entry sits in that row's "..." menu. Session rows get a role marker plus a
 * compact role badge. Both read the local roster, the ledger's authority for
 * supervisor/worker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconChecklistOutlineRegular,
  IconPlusOutlineRegular,
  IconShieldOutlineRegular,
  IconUserOutlineRegular,
  IconTrashOutlineRegular,
  Menu,
  MenuItemButton,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreProjectState } from './contract/slots.ts'
import type { SidebarKey } from './locales.ts'
import {
  type CadreStallState,
  executionText,
  lastErrorText,
  lastErrorTooltip,
  stallStateText,
} from './cadre-stall.ts'
import css from './CadreSidebar.module.css'

/*
 * Owner shares of the ui-workspace seats this package contributes to. They are
 * declared here structurally rather than through `PropsRuntime`: ui-workspace
 * depends on ui-sidebar, so this package cannot reference that client program
 * without a project-reference cycle. The ui-workspace contract remains the
 * authority for the exact shapes.
 */
interface CadreProjectRowOwner {
  readonly workspaceId: string
  readonly label: string
  readonly cwd?: string
}

interface CadreSessionRowOwner {
  readonly sessionId: string
}

interface CadreSessionMenuOwner {
  readonly sessionId: string
  readonly displayTitle: string
}

/** The row menu's open-state pair, bound by the owner as the slot's hookContext. */
type UseMenuOpenState = () => readonly [open: boolean, setOpen: (open: boolean) => void]

/** One member as `cadre:listRoster` returns it. */
export interface CadreRosterMember {
  readonly sessionId: string
  readonly role: string
  readonly displayName?: string
  readonly description?: string
  readonly state?: string
}

export interface CadreProjectRosterState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly memberCount: number
  readonly error?: string
}

export interface CadreRosterState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly members: readonly CadreRosterMember[]
  readonly error: string | null
  /** Set when the ledger was recreated and a formerly populated roster is gone. */
  readonly notice?: string | null
  /** Per-project read state; absent in old fixtures, present in production reads. */
  readonly projects?: ReadonlyMap<string, CadreProjectRosterState>
}

/** The part of one official Session summary the row subtitle reads. */
export interface CadreSessionSummary {
  readonly running?: boolean
  readonly updatedAt?: number
  readonly displayTitle?: string
  readonly retainedBy?: { readonly mainView?: number }
}

export interface CadreSessionsState {
  readonly byId: Readonly<Record<string, CadreSessionSummary | undefined>>
}

/** One ledger task projected for the row subtitle. */
export interface CadreTaskFact {
  readonly assigneeSessionId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: string
}

/** Statuses that still occupy an employee (ordered for "current task" choice). */
const ACTIVE_TASK_STATUS = new Set(['in_progress', 'accepted', 'rework', 'review', 'delivered', 'dispatched'])

/** Face of the project-row action entries. */
export interface CadreProjectActionsInjected {
  hooks: {
    projectState: HostObservable<CadreProjectState>
    roster: HostObservable<CadreRosterState>
  }
  startSession: (workspaceId: string) => void
  requestCadreCreate: (kind: 'supervisor' | 'worker', workspaceId: string) => void
  retryRoster: () => void
}

/** Face of the project-menu ledger entry. */
export interface CadreLedgerMenuInjected {
  openLedger: (request: { projectId: string; label: string; cwd?: string }) => void
}

/** Face of the Session identity entries. */
export interface CadreRosterBadgeInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    sessions: HostObservable<CadreSessionsState>
  }
}

/** Face of the Session row's second line: identity + live activity. */
export interface CadreSessionSubtitleInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    sessions: HostObservable<CadreSessionsState>
    tasks: HostObservable<readonly CadreTaskFact[]>
    stall: HostObservable<CadreStallState>
  }
}

/** A retire request raised by the row menu; the dialog lives outside it. */
export interface CadreRetireRequest {
  readonly sessionId: string
  readonly displayTitle: string
  readonly token: number
}

/** Task disposition accepted by the retire IPC; transfer is disabled in 0.9.3. */
export type CadreRetireTaskDisposition = 'cancel' | 'return' | 'transfer'

/** One open task returned by the backend's OPEN_TASKS refusal. */
export interface CadreOpenTask {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: string
}

/** Optional fields sent with the second retire attempt. */
export interface CadreRetireOptions {
  readonly taskDisposition?: CadreRetireTaskDisposition
  readonly transferTo?: string
  readonly actorSessionId?: string
}

/** Result of a retire attempt, including the open-task blocker. */
export interface CadreRetireResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly tasks?: readonly CadreOpenTask[]
}

/** Face of the retire action: the menu row raises, the overlay dialog answers. */
export interface CadreRetireInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    request: HostObservable<CadreRetireRequest | null>
  }
  requestRetire: (sessionId: string, displayTitle: string) => void
  settleRetire: () => void
  retire: (sessionId: string, options?: CadreRetireOptions) => Promise<CadreRetireResult>
}

function memberOf(members: readonly CadreRosterMember[], sessionId: string): CadreRosterMember | undefined {
  return members.find(member => member.sessionId === sessionId)
}

/** Grace between leaving the trigger/menu and actually closing it. */
const HOVER_CLOSE_DELAY_MS = 360

let menuClassSeq = 0

/**
 * Keep a portaled menu open while the pointer travels from its trigger into
 * the list. The trigger wrapper and the portaled list share one close timer:
 * entering either side cancels it, leaving both arms it after a short grace.
 * Portaled lists are outside the trigger's DOM subtree, so the list is found
 * by the unique class passed to `Menu.listClassName` and observed natively.
 *
 * @param open - whether the menu is currently open.
 * @param close - owner close action, invoked after the grace elapses.
 * @param listClass - unique class put on the portaled list.
 * @returns pointer handlers for the trigger container.
 */
function useHoverMenuGuard(open: boolean, close: () => void, listClass: string): {
  enter: () => void
  leave: () => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  const cancel = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])
  const arm = useCallback(() => {
    cancel()
    timer.current = setTimeout(() => {
      timer.current = null
      closeRef.current()
    }, HOVER_CLOSE_DELAY_MS)
  }, [cancel])

  useEffect(() => {
    if (!open) return
    let list: Element | null = null
    let frame = 0
    let disposed = false
    const bind = (): void => {
      if (disposed) return
      list = document.querySelector(`.${listClass}`)
      if (list === null) {
        frame = window.requestAnimationFrame(bind)
        return
      }
      list.addEventListener('pointerenter', cancel)
      list.addEventListener('pointerleave', arm)
    }
    bind()
    return () => {
      disposed = true
      if (frame !== 0) window.cancelAnimationFrame(frame)
      cancel()
      list?.removeEventListener('pointerenter', cancel)
      list?.removeEventListener('pointerleave', arm)
    }
  }, [open, listClass, cancel, arm])

  useEffect(() => cancel, [cancel])

  return { enter: cancel, leave: arm }
}

/** A per-occurrence unhashed class so the guard can find its own portaled list. */
function useMenuListClass(): string {
  const [name] = useState(() => {
    menuClassSeq += 1
    return `cadre-hover-menu-${String(menuClassSeq)}`
  })
  return name
}

/**
 * Per-project roster state on the project row. Loading and empty are distinct
 * from a failed read; a failed read owns a retry action instead of looking
 * like a healthy empty team.
 */
function CadreProjectRosterStatus({
  workspaceId, useRoster, retryRoster, t,
}: {
  workspaceId: string
  useRoster: InjectFace<CadreProjectActionsInjected>['useRoster']
  retryRoster: () => void
  t: PropsLocale<'sidebar'>['t']
}) {
  const project = useRoster(state => state.projects?.get(workspaceId))
  if (project === undefined) return null
  if (project.status === 'loading') {
    return <span className={css.projectRosterState} role="status">{t('roster.loading')}</span>
  }
  if (project.status === 'error') {
    return (
      <button
        type="button"
        className={`${css.projectRosterState} ${css.projectRosterError}`}
        title={project.error ?? t('roster.readFailed')}
        aria-label={project.error === undefined ? t('roster.retryAria') : t('roster.retryAriaError', { error: project.error })}
        onClick={retryRoster}
      >
        {t('roster.readFailedRetry')}
      </button>
    )
  }
  if (project.memberCount === 0) {
    return <span className={css.projectRosterState} role="status">{t('roster.empty')}</span>
  }
  return null
}

/**
 * Project row actions: the ＋ menu (supervisor/employee/plain).
 * The old single New Session button is replaced by the ＋ when this slot is
 * occupied (see ui-workspace's ProjectRowItem).
 */
export function CadreProjectRowActions({
  workspaceId, label, useProjectState, useRoster, retryRoster,
  startSession, requestCadreCreate, t,
}: CadreProjectRowOwner & InjectFace<CadreProjectActionsInjected> & PropsLocale<'sidebar'>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuClass = useMenuListClass()
  const closeMenu = useCallback(() => { setMenuOpen(false) }, [])
  const hover = useHoverMenuGuard(menuOpen, closeMenu, menuClass)
  const hasSupervisor = useProjectState(state => state.supervisors.has(workspaceId))
  return (
    <span
      className={css.projectActions}
      onClick={(event) => { event.stopPropagation() }}
      onPointerEnter={hover.enter}
      onPointerLeave={hover.leave}
    >
      <span className={css.projectActionButtons}>
        <Menu
          open={menuOpen}
          onClose={closeMenu}
          listClassName={menuClass}
          items={[
            {
              id: 'supervisor',
              label: hasSupervisor ? t('create.menu.supervisorExisting') : t('role.supervisor'),
              disabled: hasSupervisor,
            },
            { id: 'worker', label: t('role.worker') },
            { id: 'plain', label: t('create.menu.plain') },
          ]}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'plain') {
              startSession(workspaceId)
              return
            }
            if (id === 'supervisor' || id === 'worker') requestCadreCreate(id, workspaceId)
          }}
          anchor={(
            <Tooltip label={t('create.menu.tooltip')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('create.inProjectAria', { label })}
                onClick={() => { setMenuOpen(open => !open) }}
              >
                <IconPlusOutlineRegular size={14} />
              </button>
            </Tooltip>
          )}
          portal
        />
      </span>
      <CadreProjectRosterStatus workspaceId={workspaceId} useRoster={useRoster} retryRoster={retryRoster} t={t} />
    </span>
  )
}

/**
 * Project-menu 台账 entry (order 100, before the shipped rename/delete rows).
 * Opens the read-only ledger overlay for the row's project, then dismisses
 * the "..." menu it sits in.
 * @param props - owner share, menu open state, the ledger hop, and the locale seat.
 * @returns the menu row.
 */
export function CadreProjectLedgerMenuItem({
  workspaceId, label, cwd, useMenuOpenState, openLedger, t,
}: CadreProjectRowOwner & { useMenuOpenState: UseMenuOpenState } & InjectFace<CadreLedgerMenuInjected> & PropsLocale<'sidebar'>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconChecklistOutlineRegular />}
      onSelect={() => {
        openLedger({ projectId: workspaceId, label, ...(cwd === undefined ? {} : { cwd }) })
        setMenuOpen(false)
      }}
    >
      {t('ledger.entry')}
    </MenuItemButton>
  )
}

/**
 * Badge beside the title: 组长 (shield) / 岗位 (person, icon-only when no
 * position); ordinary Sessions stay bare. The unhashed `cadre-role-*` token
 * lets this module's stylesheet tint the official row title, whose class
 * ui-workspace owns.
 */
export function CadreSessionBadge({
  sessionId, useRoster, t,
}: CadreSessionRowOwner & InjectFace<CadreRosterBadgeInjected> & PropsLocale<'sidebar'>) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined) return null
  if (member.state === 'departed') {
    return (
      <span className={css.departedBadge} title={t('badge.departedTitle')}>
        {t('badge.departed')}
      </span>
    )
  }
  if (member.role === 'supervisor') {
    return (
      <span className={`${css.supervisorBadge} cadre-role-supervisor`}>
        <IconShieldOutlineRegular size={11} aria-hidden="true" />
        {t('role.supervisor')}
      </span>
    )
  }
  const position = member.description?.trim()
  if (position === undefined || position === '') {
    const name = member.displayName ?? member.sessionId
    return (
      <span className={`${css.workerBadge} cadre-role-worker`} aria-label={name} title={name}>
        <IconUserOutlineRegular size={11} aria-hidden="true" />
      </span>
    )
  }
  return (
    <span
      className={`${css.workerBadge} cadre-role-worker`}
      title={t('badge.positionTitle', { position })}
    >
      <IconUserOutlineRegular size={11} aria-hidden="true" />
      {position}
    </span>
  )
}

/**
 * Second line of a Session row: the job title in plain sight plus what the
 * employee is doing now (running / idle / waiting for review) from the
 * ledger's tasks. Ordinary Sessions say so; archived members say nothing.
 */
export function CadreSessionSubtitle({
  sessionId, t, useRoster, useSessions, useTasks, useStall,
}: CadreSessionRowOwner & InjectFace<CadreSessionSubtitleInjected> & PropsLocale<'sidebar'>) {
  const rosterStatus = useRoster(state => state.status)
  const members = useRoster(state => state.members)
  const notice = useRoster(state => state.notice)
  const running = useSessions(state => state.byId[sessionId]?.running === true)
  const tasks = useTasks(state => state)
  const member = memberOf(members, sessionId)
  const stall = useStall(state => state.bySession.get(sessionId))

  if (member === undefined) {
    // A recreated ledger must not masquerade as an ordinary session: say the
    // roster is missing so the user can restore it instead of silently
    // rebuilding the team.
    if (notice !== undefined && notice !== null && notice !== '') {
      return <span className={css.plainSubtitle} title={notice}>{t('subtitle.dataLost')}</span>
    }
    // Before the roster answers, an unknown row must not claim to be ordinary.
    return rosterStatus === 'ready' ? <span className={css.plainSubtitle}>{t('subtitle.plain')}</span> : null
  }
  if (member.state === 'departed') {
    return <span className={css.plainSubtitle} title={t('subtitle.departedTitle')}>{t('subtitle.departed')}</span>
  }

  const lastError = stall?.lastError
  if (lastError !== null && lastError !== undefined) {
    return (
      <span className={css.sessionSubtitle} title={lastErrorTooltip(lastError, t)}
        data-last-error-code={lastError.code}>
        <span className={css.statusDotError} aria-hidden="true" />
        <span className={css.subtitleText}>{lastErrorText(lastError, t)}</span>
      </span>
    )
  }

  const owned = tasks.filter(task => task.assigneeSessionId === sessionId && ACTIVE_TASK_STATUS.has(task.status))
  const current = owned.find(task => task.status === 'in_progress') ?? owned[0]
  const progress = executionText(stall?.execution, t)

  if (member.role === 'supervisor') {
    const activity = running ? t('subtitle.running') : t('subtitle.idle')
    return (
      <span className={css.sessionSubtitle}>
        <span className={progress === '' ? (running ? css.statusDotRunning : css.statusDotIdle) : css.statusDotExecution} aria-hidden="true" />
        <span className={css.subtitleText}>
          {activity}{progress === '' ? (running ? t('subtitle.decomposing') : '') : t('subtitle.progressSuffix', { progress })}
        </span>
      </span>
    )
  }

  const pending = owned.filter(task => task.status === 'delivered' || task.status === 'review').length
  const activity = running
    ? (current === undefined ? t('subtitle.running') : t('subtitle.runningTask', { title: current.title }))
    : pending > 0
      ? t('subtitle.idlePending', { count: String(pending) })
      : owned.length > 0
        ? t('subtitle.idleOwned', { count: String(owned.length) })
        : t('subtitle.idle')
  const stallText = progress !== ''
    ? t('subtitle.progressSuffix', { progress })
    : stall === undefined ? '' : t('subtitle.progressSuffix', { progress: stallStateText(stall.worstState, stall.lastActivityAt, t) })
  const dotClass = progress !== ''
    ? css.statusDotExecution
    : stall?.worstState === 'stalled'
      ? css.statusDotStalled
      : stall?.worstState === 'possibly_stalled'
        ? css.statusDotMaybeStalled
        : running ? css.statusDotRunning : css.statusDotIdle
  return (
    <span className={css.sessionSubtitle}>
      <span className={dotClass} aria-hidden="true" />
      <span className={css.subtitleText}>{activity}{stallText}</span>
    </span>
  )
}


/**
 * Row-menu retire action for members. Ordinary Sessions do not get it. The
 * menu row only raises the request: this subtree unmounts when the menu
 * closes, so a dialog rendered here would never appear.
 */
export function CadreRetireMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, requestRetire, t,
}: CadreSessionMenuOwner & { useMenuOpenState: UseMenuOpenState } & InjectFace<CadreRetireInjected> & PropsLocale<'sidebar'>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined || member.state === 'departed') return null
  const supervisor = member.role === 'supervisor'
  return (
    <MenuItemButton
      icon={<IconTrashOutlineRegular />}
      danger
      separatorBefore
      onSelect={() => {
        setMenuOpen(false)
        requestRetire(sessionId, displayTitle)
      }}
    >
      {supervisor ? t('retire.menu.supervisor') : t('retire.menu')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` dialog that answers a retire request. It sits outside
 * the row menu so closing the menu does not unmount it mid-confirmation.
 * @param props - request hook, roster, the retire hop, and settlement.
 * @returns the dialog for the current request, or null.
 */
export function CadreRetireDialog({ useRoster, useRequest, retire, settleRetire, t }: InjectFace<CadreRetireInjected> & PropsLocale<'sidebar'>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return (
    <RetireForm
      key={request.token}
      request={request}
      useRoster={useRoster}
      retire={retire}
      settleRetire={settleRetire}
      t={t}
    />
  )
}

const RETIRE_TASK_STATUS_KEYS: Readonly<Record<string, SidebarKey>> = {
  dispatched: 'status.inProgress',
  accepted: 'status.inProgress',
  in_progress: 'status.inProgress',
  delivered: 'status.pendingReview',
  review: 'status.pendingReview',
  rework: 'status.rework',
}

function retireTaskStatus(status: string, t: PropsLocale<'sidebar'>['t']): string {
  const key = RETIRE_TASK_STATUS_KEYS[status]
  return key === undefined ? status : t(key)
}

function RetireForm({ request, useRoster, retire, settleRetire, t }: {
  readonly request: CadreRetireRequest
  readonly useRoster: InjectFace<CadreRetireInjected>['useRoster']
  readonly retire: CadreRetireInjected['retire']
  readonly settleRetire: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, request.sessionId)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openTasks, setOpenTasks] = useState<readonly CadreOpenTask[] | null>(null)
  const [disposition, setDisposition] = useState<'cancel' | 'return' | ''>('')
  const supervisor = member?.role === 'supervisor'
  const close = (): void => { if (!pending) settleRetire() }
  const run = async (): Promise<void> => {
    setPending(true)
    setError(null)
    const result = disposition === ''
      ? await retire(request.sessionId)
      : await retire(request.sessionId, { taskDisposition: disposition })
    setPending(false)
    if (!result.ok) {
      if (result.code === 'OPEN_TASKS') {
        const tasks = result.tasks ?? []
        setOpenTasks(tasks)
        setDisposition('')
        setError(tasks.length === 0
          ? `${result.code} · ${result.message ?? t('retire.openTasksMissing')}`
          : null)
        return
      }
      setError(`${result.code ?? 'ERROR'} · ${result.message ?? t('retire.failed')}`)
      return
    }
    settleRetire()
  }
  return (
    <Modal
      open
      onClose={close}
      title={supervisor ? t('retire.title.supervisor') : t('retire.title.worker')}
      description={`${member?.displayName ?? request.displayTitle} · ${request.sessionId}`}
      closeLabel={t('dialog.close')}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('dialog.cancel')}</Button>
          <Button
            variant="primary"
            disabled={pending || (openTasks !== null && disposition === '')}
            onClick={() => { void run() }}
          >
            {pending ? t('dialog.processing') : t('retire.confirm')}
          </Button>
        </>
      )}
    >
      <div className={css.dialogBody}>
        <p className={css.hint}>
          {t('retire.hint')}
          {supervisor ? t('retire.hintSupervisorSuffix') : t('retire.hintWorkerSuffix')}
        </p>
        {openTasks !== null && openTasks.length > 0 && (
          <section className={css.retireTasks} aria-label={t('retire.openTasksAria')}>
            <p className={css.retireBlocker}>
              {t('retire.openTasksBlocker', { count: String(openTasks.length) })}
            </p>
            <ul className={css.retireTaskList}>
              {openTasks.map(task => (
                <li key={task.taskId} className={css.retireTask} data-task-id={task.taskId}>
                  <span className={css.retireTaskMain}>
                    <span className={css.retireTaskTitle} title={task.title}>{task.title}</span>
                    <code className={css.retireTaskId}>{task.taskId}</code>
                  </span>
                  <span className={css.retireTaskStatus}>{retireTaskStatus(task.status, t)}</span>
                </li>
              ))}
            </ul>
            <div className={css.retireOptions} role="radiogroup" aria-label={t('retire.dispositionAria')}>
              <button
                type="button"
                role="radio"
                aria-checked={disposition === 'cancel'}
                className={css.retireOption}
                disabled={pending}
                onClick={() => { setDisposition('cancel') }}
              >
                {t('retire.cancelTasks')}
              </button>
              {!supervisor && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={disposition === 'return'}
                  className={css.retireOption}
                  disabled={pending}
                  onClick={() => { setDisposition('return') }}
                >
                  {t('retire.returnToSupervisor')}
                </button>
              )}
              {supervisor && (
                <span className={css.hint}>{t('retire.supervisorNoReturn')}</span>
              )}
              <button
                type="button"
                role="radio"
                aria-checked={false}
                aria-label={t('retire.transferAria')}
                className={css.retireOption}
                disabled
              >
                {t('retire.transfer')}
              </button>
              <span className={css.hint}>{t('retire.transferHint')}</span>
            </div>
          </section>
        )}
        {error !== null && <p role="alert" className={css.error}>{error}</p>}
      </div>
    </Modal>
  )
}
