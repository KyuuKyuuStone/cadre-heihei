/**
 * Cadre contributions that live on the official sidebar rows.
 *
 * The project (workspace) row gets the three-way ＋ menu and the read-only
 * 台账 entry; Session rows get a role marker plus a compact role badge. Both
 * read the local roster, the ledger's authority for supervisor/worker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconShieldOutlineRegular,
  IconUserOutlineRegular,
  Input,
  Menu,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreProjectState } from './contract/slots.ts'
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

export interface CadreRosterState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly members: readonly CadreRosterMember[]
  readonly error: string | null
  /** Set when the ledger was recreated and a formerly populated roster is gone. */
  readonly notice?: string | null
}

/** The part of one official Session summary the row subtitle reads. */
export interface CadreSessionSummary {
  readonly running?: boolean
  readonly updatedAt?: number
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
  hooks: { projectState: HostObservable<CadreProjectState> }
  startSession: (workspaceId: string) => void
  requestCadreCreate: (kind: 'supervisor' | 'worker', workspaceId: string) => void
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
  }
}

/** A retire request raised by the row menu; the dialog lives outside it. */
export interface CadreRetireRequest {
  readonly sessionId: string
  readonly displayTitle: string
  readonly token: number
}

/** Face of the retire action: the menu row raises, the overlay dialog answers. */
export interface CadreRetireInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    request: HostObservable<CadreRetireRequest | null>
  }
  requestRetire: (sessionId: string, displayTitle: string) => void
  settleRetire: () => void
  retire: (sessionId: string) => Promise<{ ok: boolean; code?: string; message?: string }>
}

/** Face of the row-menu profile edit action. */
export interface CadreEditInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
  updateMember: (input: {
    sessionId: string
    displayName: string
    description: string
  }) => Promise<{ ok: boolean; code?: string; message?: string }>
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
 * Project row actions: ＋ (supervisor/employee/plain) and 台账.
 * The old single New Session button is replaced by the ＋ when this slot is
 * occupied (see ui-workspace's ProjectRowItem).
 */
export function CadreProjectRowActions({
  workspaceId, label, cwd, useProjectState, startSession, requestCadreCreate, openLedger,
}: CadreProjectRowOwner & InjectFace<CadreProjectActionsInjected>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuClass = useMenuListClass()
  const closeMenu = useCallback(() => { setMenuOpen(false) }, [])
  const hover = useHoverMenuGuard(menuOpen, closeMenu, menuClass)
  const hasSupervisor = useProjectState(state => state.supervisors.has(workspaceId))
  return (
    <span
      className={css.projectActions}
      onClick={event => { event.stopPropagation() }}
      onPointerEnter={hover.enter}
      onPointerLeave={hover.leave}
    >
      <Menu
        open={menuOpen}
        onClose={closeMenu}
        listClassName={menuClass}
        items={[
          {
            id: 'supervisor',
            label: hasSupervisor ? '主管（已有）' : '主管',
            disabled: hasSupervisor,
          },
          { id: 'worker', label: '员工' },
          { id: 'plain', label: '普通会话' },
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
          <Tooltip label="新建主管 / 员工 / 普通会话" side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={`在“${label}”中新建`}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
        portal
      />
      <Button
        variant="outline"
        size="sm"
        aria-label={`查看“${label}”台账`}
        onClick={() => { openLedger({ projectId: workspaceId, label, ...(cwd === undefined ? {} : { cwd }) }) }}
      >
        台账
      </Button>
    </span>
  )
}

/**
 * Badge beside the title: 主管 (shield) / 员工 · 岗位 (person); ordinary
 * Sessions stay bare. The unhashed `cadre-role-*` token lets this module's
 * stylesheet tint the official row title, whose class ui-workspace owns.
 */
export function CadreSessionBadge({
  sessionId, useRoster,
}: CadreSessionRowOwner & InjectFace<CadreRosterBadgeInjected>) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined || member.state === 'departed') return null
  if (member.role === 'supervisor') {
    return (
      <span className={`${css.supervisorBadge} cadre-role-supervisor`}>
        <IconShieldOutlineRegular size={11} aria-hidden="true" />
        主管
      </span>
    )
  }
  const position = member.description?.trim()
  return (
    <span
      className={`${css.workerBadge} cadre-role-worker`}
      title={position === undefined ? undefined : `岗位：${position}`}
    >
      <IconUserOutlineRegular size={11} aria-hidden="true" />
      {position === undefined || position === '' ? '员工' : `员工 · ${position}`}
    </span>
  )
}

/**
 * Second line of a Session row: the job title in plain sight plus what the
 * employee is doing now (running / idle / waiting for review) from the
 * ledger's tasks. Ordinary Sessions say so; archived members say nothing.
 */
export function CadreSessionSubtitle({
  sessionId, useRoster, useSessions, useTasks,
}: CadreSessionRowOwner & InjectFace<CadreSessionSubtitleInjected>) {
  const rosterStatus = useRoster(state => state.status)
  const members = useRoster(state => state.members)
  const notice = useRoster(state => state.notice)
  const running = useSessions(state => state.byId[sessionId]?.running === true)
  const tasks = useTasks(state => state)
  const member = memberOf(members, sessionId)

  if (member === undefined || member.state === 'departed') {
    // A recreated ledger must not masquerade as an ordinary session: say the
    // roster is missing so the user can restore it instead of silently
    // rebuilding the team.
    if (notice !== undefined && notice !== null && notice !== '') {
      return <span className={css.plainSubtitle} title={notice}>团队数据丢失</span>
    }
    // Before the roster answers, an unknown row must not claim to be ordinary.
    return rosterStatus === 'ready' ? <span className={css.plainSubtitle}>普通会话</span> : null
  }

  const owned = tasks.filter(task => task.assigneeSessionId === sessionId && ACTIVE_TASK_STATUS.has(task.status))
  const current = owned.find(task => task.status === 'in_progress') ?? owned[0]

  if (member.role === 'supervisor') {
    return (
      <span className={css.sessionSubtitle}>
        <span className={running ? css.statusDotRunning : css.statusDotIdle} aria-hidden="true" />
        <span className={css.subtitleText}>{running ? '运行中 · 正在拆解' : '空闲'}</span>
      </span>
    )
  }

  const pending = owned.filter(task => task.status === 'delivered' || task.status === 'review').length
  const activity = running
    ? (current === undefined ? '运行中' : `运行中 · ${current.title}`)
    : pending > 0
      ? `空闲 · 待验收 ${String(pending)}`
      : owned.length > 0
        ? `空闲 · 待处理 ${String(owned.length)}`
        : '空闲'
  return (
    <span className={css.sessionSubtitle}>
      <span className={running ? css.statusDotRunning : css.statusDotIdle} aria-hidden="true" />
      <span className={css.subtitleText}>{activity}</span>
    </span>
  )
}


/**
 * Row-menu profile edit: name and role description are the two pieces the
 * ledger stores for a member; no preset/template switch is exposed.
 */
export function CadreEditMemberMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, updateMember,
}: CadreSessionMenuOwner & { useMenuOpenState: UseMenuOpenState } & InjectFace<CadreEditInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (member === undefined || member.state === 'departed') return null
  const begin = (): void => {
    setMenuOpen(false)
    setName(member.displayName ?? displayTitle)
    setDescription(member.description ?? '')
    setError(null)
    setOpen(true)
  }
  const save = async (): Promise<void> => {
    const displayName = name.trim()
    if (displayName === '') {
      setError('名称不能为空')
      return
    }
    setPending(true)
    setError(null)
    const result = await updateMember({ sessionId, displayName, description: description.trim() })
    setPending(false)
    if (!result.ok) {
      setError(`${result.code ?? 'ERROR'} · ${result.message ?? '保存失败'}`)
      return
    }
    setOpen(false)
  }
  return (
    <>
      <button type="button" role="menuitem" className={css.menuItem} onClick={begin}>
        编辑资料…
      </button>
      <Modal
        open={open}
        onClose={() => { if (!pending) setOpen(false) }}
        title={member.role === 'supervisor' ? '主管资料' : '员工资料'}
        description={`${member.displayName ?? displayTitle} · ${sessionId}`}
        closeLabel="关闭"
        className={css.editDialog ?? ''}
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setOpen(false) }}>取消</Button>
            <Button variant="primary" disabled={pending} onClick={() => { void save() }}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      >
        <div className={css.dialogBody}>
          <label className={css.label} htmlFor="cadre-member-name">名称</label>
          <Input
            id="cadre-member-name"
            value={name}
            disabled={pending}
            onChange={event => { setName(event.target.value) }}
          />
          <label className={css.label} htmlFor="cadre-member-description">岗位 / 职责描述</label>
          <textarea
            id="cadre-member-description"
            className={css.textarea}
            value={description}
            rows={5}
            maxLength={2000}
            disabled={pending}
            onChange={event => { setDescription(event.target.value) }}
          />
          <span className={css.hint}>这里是运行时注入的职责描述，也是会话行上的岗位标识；最多 2000 字。</span>
          {error !== null && <p role="alert" className={css.error}>{error}</p>}
        </div>
      </Modal>
    </>
  )
}

/**
 * Row-menu retire action for members. Ordinary Sessions do not get it. The
 * menu row only raises the request: this subtree unmounts when the menu
 * closes, so a dialog rendered here would never appear.
 */
export function CadreRetireMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, requestRetire,
}: CadreSessionMenuOwner & { useMenuOpenState: UseMenuOpenState } & InjectFace<CadreRetireInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined || member.state === 'departed') return null
  const supervisor = member.role === 'supervisor'
  return (
    <button
      type="button"
      role="menuitem"
      className={css.menuItem}
      onClick={() => {
        setMenuOpen(false)
        requestRetire(sessionId, displayTitle)
      }}
    >
      {supervisor ? '主管离职（取消任命）…' : '离职…'}
    </button>
  )
}

/**
 * The `shell.overlay` dialog that answers a retire request. It sits outside
 * the row menu so closing the menu does not unmount it mid-confirmation.
 * @param props - request hook, roster, the retire hop, and settlement.
 * @returns the dialog for the current request, or null.
 */
export function CadreRetireDialog({ useRoster, useRequest, retire, settleRetire }: InjectFace<CadreRetireInjected>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return (
    <RetireForm
      key={request.token}
      request={request}
      useRoster={useRoster}
      retire={retire}
      settleRetire={settleRetire}
    />
  )
}

function RetireForm({ request, useRoster, retire, settleRetire }: {
  readonly request: CadreRetireRequest
  readonly useRoster: InjectFace<CadreRetireInjected>['useRoster']
  readonly retire: CadreRetireInjected['retire']
  readonly settleRetire: () => void
}) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, request.sessionId)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supervisor = member?.role === 'supervisor'
  const close = (): void => { if (!pending) settleRetire() }
  const run = async (): Promise<void> => {
    setPending(true)
    setError(null)
    const result = await retire(request.sessionId)
    setPending(false)
    if (!result.ok) {
      setError(`${result.code ?? 'ERROR'} · ${result.message ?? '离职失败'}`)
      return
    }
    settleRetire()
  }
  return (
    <Modal
      open
      onClose={close}
      title={supervisor ? '主管离职' : '员工离职'}
      description={`${member?.displayName ?? request.displayTitle} · ${request.sessionId}`}
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>取消</Button>
          <Button variant="primary" disabled={pending} onClick={() => { void run() }}>
            {pending ? '处理中…' : '确认离职'}
          </Button>
        </>
      )}
    >
      <div className={css.dialogBody}>
        <p className={css.hint}>
          离职后从在职花名册移除，会话与历史任务保留
          {supervisor ? '；该项目部随后可以新建主管。' : '。'}
        </p>
        {error !== null && <p role="alert" className={css.error}>{error}</p>}
      </div>
    </Modal>
  )
}
