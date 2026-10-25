/**
 * Cadre contributions that live on the official sidebar rows.
 *
 * The project (workspace) row gets the three-way ＋ menu and the read-only
 * 台账 entry; Session rows get a role marker plus a compact role badge. Both
 * read the local roster, the ledger's authority for supervisor/worker.
 */
import { useState } from 'react'
import {
  Button,
  IconNewChatOutlineRegular,
  IconPlusOutlineRegular,
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
}

/** Face of the project-row action entries. */
export interface CadreProjectActionsInjected {
  hooks: { projectState: HostObservable<CadreProjectState> }
  startSession: (workspaceId: string) => void
  requestCadreCreate: (kind: 'supervisor' | 'worker', workspaceId: string) => void
  openLedger: (request: { projectId: string; label: string; cwd?: string }) => void
}

/** Face of the full-width New Session row under a project header. */
export interface CadreNewSessionRowInjected {
  hooks: { projectState: HostObservable<CadreProjectState> }
  startSession: (workspaceId: string) => void
  requestCadreCreate: (kind: 'supervisor' | 'worker', workspaceId: string) => void
  refreshSupervisor: () => void
}

/** Face of the Session identity entries. */
export interface CadreRosterBadgeInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
}

/** Face of the row-menu retire action. */
export interface CadreRetireInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
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

/**
 * Project row actions: ＋ (supervisor/employee/plain) and 台账.
 * The old single New Session button is replaced by the ＋ when this slot is
 * occupied (see ui-workspace's ProjectRowItem).
 */
export function CadreProjectRowActions({
  workspaceId, label, cwd, useProjectState, startSession, requestCadreCreate, openLedger,
}: CadreProjectRowOwner & InjectFace<CadreProjectActionsInjected>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasSupervisor = useProjectState(state => state.supervisors.has(workspaceId))
  return (
    <span className={css.projectActions} onClick={event => { event.stopPropagation() }}>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
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
        closeOnPointerLeave
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
 * Full-width New Session entry directly under a project header. It opens the
 * same three-way menu as the project-row ＋, so the position the official
 * blank-session row used to occupy always offers a create affordance.
 */
export function CadreNewSessionRow({
  workspaceId, useProjectState, startSession, requestCadreCreate, refreshSupervisor,
}: CadreProjectRowOwner & InjectFace<CadreNewSessionRowInjected>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasSupervisor = useProjectState(state => state.supervisors.has(workspaceId))
  return (
    <Menu
      className={css.newSessionRowMenu}
      open={menuOpen}
      onClose={() => { setMenuOpen(false) }}
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
        <button
          type="button"
          className={css.newSessionRow}
          data-cadre-new-session=""
          onClick={() => {
            if (!menuOpen) refreshSupervisor()
            setMenuOpen(open => !open)
          }}
        >
          <IconNewChatOutlineRegular size={14} />
          <span>新会话</span>
        </button>
      )}
      portal
      side="bottom"
      align="start"
    />
  )
}

/** Leading 16px cell: supervisor solid square, employee hollow circle. */
export function CadreSessionMarker({
  sessionId, useRoster,
}: CadreSessionRowOwner & InjectFace<CadreRosterBadgeInjected>) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined || member.state === 'departed') return null
  return member.role === 'supervisor'
    ? <span className={css.supervisorMarker} aria-hidden="true" />
    : <span className={css.workerMarker} aria-hidden="true" />
}

/** Badge beside the title: 主管 / 员工 · 岗位; ordinary Sessions stay bare. */
export function CadreSessionBadge({
  sessionId, useRoster,
}: CadreSessionRowOwner & InjectFace<CadreRosterBadgeInjected>) {
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  if (member === undefined || member.state === 'departed') return null
  if (member.role === 'supervisor') {
    return <span className={css.supervisorBadge}>主管</span>
  }
  const position = member.description?.trim()
  return (
    <span className={css.workerBadge}>
      {position === undefined || position === '' ? '员工' : `员工 · ${position}`}
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
 * Row-menu retire action for members. Ordinary Sessions do not get it; the
 * confirm dialog keeps the destructive step explicit.
 */
export function CadreRetireMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, retire,
}: CadreSessionMenuOwner & { useMenuOpenState: UseMenuOpenState } & InjectFace<CadreRetireInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const member = memberOf(members, sessionId)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (member === undefined || member.state === 'departed') return null
  const supervisor = member.role === 'supervisor'
  const run = async (): Promise<void> => {
    setPending(true)
    setError(null)
    const result = await retire(sessionId)
    setPending(false)
    if (!result.ok) {
      setError(`${result.code ?? 'ERROR'} · ${result.message ?? '离职失败'}`)
      return
    }
    setOpen(false)
  }
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={css.menuItem}
        onClick={() => {
          setMenuOpen(false)
          setError(null)
          setOpen(true)
        }}
      >
        {supervisor ? '主管离职（取消任命）…' : '离职…'}
      </button>
      <Modal
        open={open}
        onClose={() => { if (!pending) setOpen(false) }}
        title={supervisor ? '主管离职' : '员工离职'}
        description={`${member.displayName ?? displayTitle} · ${sessionId}`}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setOpen(false) }}>取消</Button>
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
    </>
  )
}
