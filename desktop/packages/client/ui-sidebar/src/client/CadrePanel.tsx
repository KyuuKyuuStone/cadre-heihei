/**
 * Cadre collaboration panel.
 *
 * Reads the desktop bridge `window.cadre.listTasks` when available and falls
 * back to labelled sample rows otherwise. Write actions (dispatch / acceptance)
 * call the bridge when the main process registers them; until then the forms
 * stay interactive and report the missing channel instead of pretending success.
 * Only shipped primitives and inline layout are used; no custom palette.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  Button,
  IconBranchOutlineRegular,
  Input,
  Modal,
  Pill,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CadreRoster, type RosterState } from './CadreRoster.tsx'
import {
  CADRE_PROJECT_ID, loadCustomRoles, loadRoster, removeCustomRole, saveCustomRole,
  type CustomRole, type RosterMember, type RosterRole,
} from './cadre-roster-source.ts'

/* Bare headings/paras/textarea do not read component styles, so they name the
   semantic tokens explicitly and follow every theme override. */
const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
const TEXT_ERROR = 'var(--dsw-alias-state-error-primary)'
const BODY_TEXTAREA: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  resize: 'vertical',
  font: 'inherit',
  padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: TEXT_PRIMARY,
}

/** Newest employee report attached to a task. */
interface CadreReport {
  readonly messageId: string
  readonly reporterSessionId: string
  readonly reporterName: string
  readonly summary: string
  readonly preview: string
  readonly deliverables: readonly string[]
  readonly receivedAt: string
  readonly deliveryState: string
}

/** One ledger row rendered by the panel. */
interface CadreTask {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assignee: string
  readonly assigneeRole?: string
  readonly updatedAt?: string
  readonly report?: CadreReport
}

/** Raw row shape of `cadre:listTasks` (assignee is a session id). */
interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
  readonly assigneeName?: string
  readonly assigneeRole?: string
  readonly latestReport?: CadreReport
}

/** One roster member returned by `cadre:listRoster`. */
interface CadreMember {
  readonly sessionId: string
  readonly role: string
  readonly displayName?: string
  readonly state?: string
  readonly updatedAt?: string
}

/** Write response: the ledger reports whether the write actually landed. */
interface CadreWriteResult {
  readonly ledgerUpdated?: boolean
  readonly tasks?: CadreTaskRow[]
  readonly code?: string
  readonly message?: string
  readonly taskStatus?: string
}

/** A write is successful only when the ledger confirms it and returns rows. */
function writeSucceeded(result: CadreWriteResult | undefined): result is CadreWriteResult & { tasks: CadreTaskRow[] } {
  return result?.ledgerUpdated === true && Array.isArray(result.tasks)
}

function writeFailure(result: CadreWriteResult | undefined): string {
  const code = result?.code ?? 'ledger_not_updated'
  const message = result?.message ?? (result?.ledgerUpdated === false ? '台账未更新' : '响应缺少 tasks')
  return `写入失败：${code} · ${message}`
}

/** Bridge surface. Write methods are optional until the main process ships them. */
interface CadreBridge {
  listTasks(query: { projectId: string }): Promise<{
    projectId: string
    rows: CadreTaskRow[]
    elapsedMs?: number
  }>
  listRoster?(query: { projectId: string }): Promise<{ members?: CadreMember[]; rows?: CadreMember[] } | undefined>
  listEmployees?(query?: { projectId?: string }): Promise<{
    ok?: boolean
    employees?: readonly { sessionId: string; displayName?: string }[]
    code?: string
    message?: string
  } | undefined>
  dispatchTask?(query: {
    projectId: string
    assigneeSessionId: string
    title: string
    body: string
  }): Promise<CadreWriteResult | undefined>
  transitionTask?(query: {
    projectId: string
    taskId: string
    status: TransitionStatus
    reason?: string
  }): Promise<CadreWriteResult | undefined>
  saveMember?(query: {
    projectId: string
    sessionId: string
    role: 'worker' | 'supervisor'
    displayName?: string
  }): Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  retireMember?(query: {
    projectId: string
    sessionId: string
  }): Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  bindSession?(query: {
    projectId: string
    providerId: string
    model: string
  }): Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  listProviders?(): Promise<{
    ok?: boolean
    providers?: readonly {
      providerId: string
      name: string
      defaultModel: string
      models?: readonly { id: string }[]
    }[]
  }>
}

declare global {
  interface Window {
    cadre?: CadreBridge
  }
}

// Temporary project binding: replace with the launch configuration or the
// session's project id once the main process exposes it (same value as main.ts
// CADRE_PROJECT_ID; shared through the roster adapter).
const PROJECT_ID = CADRE_PROJECT_ID

/** Injected creation seam: the plugin creates the official Session, then the member row. */
export interface CadrePanelInjected {
  createRosterEntry(input: {
    role: RosterRole
    displayName: string
    description?: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }>
  createPlainSession(): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }>
}

const SAMPLE_TASKS: readonly CadreTask[] = [
  { taskId: 'task-101', title: '补齐 M3 验收矩阵', status: '已验收', assignee: '前端' },
  { taskId: 'task-102', title: '事件泵补发适配', status: '验收中', assignee: '前端' },
  { taskId: 'task-103', title: '默认中文与偏好回退', status: '已交付', assignee: '前端' },
  { taskId: 'task-104', title: '官方壳协作面板挂出', status: '进行中', assignee: '前端' },
]

/** Two-level acceptance: delivered → review (主管审) → verified (用户确认). */
const STATUS_LABELS: Record<string, string> = {
  dispatched: '已派发',
  accepted: '已接受',
  in_progress: '执行中',
  delivered: '待主管审',
  review: '待用户确认',
  verified: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rework: '返工',
}

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly tasks: readonly CadreTask[] }
  | { readonly kind: 'fallback'; readonly reason: string }

type TransitionStatus = 'review' | 'verified' | 'rework' | 'failed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ledger role used as the interim position label (岗位名口径尚未定稿). */
function roleLabel(role: string | undefined): string {
  return role === 'supervisor' ? '主管' : '员工'
}

/** `MM-DD HH:mm` in local time; invalid timestamps fall back to the raw value. */
function timeText(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** The first sentence of a report, bounded so one long report cannot flood the row. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '（汇报没有正文）'
  const head = (trimmed.split(/[。！？!?\n]/)[0] ?? '').trim() || trimmed
  return head.length > 120 ? `${head.slice(0, 120)}…` : head
}

/** Map a raw bridge row to the view model, keeping report data across status writes. */
function toViewTask(row: CadreTaskRow, previous?: CadreTask): CadreTask {
  const assigneeRole = row.assigneeRole ?? previous?.assigneeRole
  const updatedAt = row.updatedAt ?? previous?.updatedAt
  const report = row.latestReport ?? previous?.report
  return {
    taskId: row.taskId,
    title: row.title,
    status: row.status,
    assignee: row.assigneeName?.trim() || previous?.assignee || row.assigneeSessionId,
    ...(assigneeRole === undefined ? {} : { assigneeRole }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(report === undefined ? {} : { report }),
  }
}

/** Decorative sidebar glyph for the Cadre panel row. */
export function CadreIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}

function TaskRow({
  task,
  onAccept,
}: {
  readonly task: CadreTask
  readonly onAccept: (taskId: string) => void
}) {
  const actionable = task.status === 'delivered' || task.status === 'review'
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
      <Tag tone="neutral">{task.taskId}</Tag>
      <span style={{ flex: 1 }}>{task.title}</span>
      <span>{task.assignee}{task.assigneeRole === undefined ? '' : ` · ${roleLabel(task.assigneeRole)}`}</span>
      <Pill>{STATUS_LABELS[task.status] ?? task.status}</Pill>
      {actionable && (
        <Button variant="outline" size="sm" onClick={() => { onAccept(task.taskId) }}>
          {task.status === 'review' ? '用户确认' : '主管审核'}
        </Button>
      )}
    </li>
  )
}

/** W3 report card: who reported, which task, when, the verdict, deliverables, state. */
function ReportCard({
  task,
  onReview,
}: {
  readonly task: CadreTask
  readonly onReview: (taskId: string) => void
}) {
  const report = task.report
  const actionable = task.status === 'delivered' || task.status === 'review'
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag tone="neutral">{`${task.assignee} · ${roleLabel(task.assigneeRole)}`}</Tag>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, color: TEXT_PRIMARY }}>{task.title}</span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
          {timeText(report?.receivedAt ?? task.updatedAt)}
        </span>
        <Pill>{STATUS_LABELS[task.status] ?? task.status}</Pill>
      </div>
      <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
        任务号 {task.taskId}
        {report === undefined ? '' : ` · 汇报人 ${report.reporterName}`}
        {report === undefined ? '' : ` · 汇报 ${timeText(report.receivedAt)}`}
      </span>
      <p style={{ margin: 0, color: TEXT_PRIMARY }}>{report === undefined ? '该任务没有汇报正文（旧记录）。' : firstSentence(report.summary)}</p>
      <div style={{ color: TEXT_SECONDARY, fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span>交付物</span>
        {report === undefined || report.deliverables.length === 0
          ? <span>（未提供）</span>
          : report.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
      </div>
      {actionable && (
        <div>
          <Button variant="outline" size="sm" onClick={() => { onReview(task.taskId) }}>
            {task.status === 'review' ? '用户确认' : '主管审核'}
          </Button>
        </div>
      )}
    </li>
  )
}

/** The function cards offered at creation (W9 step 2). */
const BUILTIN_ROLES: readonly { readonly name: string; readonly description: string }[] = [
  { name: '后端', description: '接口、数据与业务逻辑' },
  { name: '前端', description: '界面、交互与样式' },
  { name: '测试', description: '用例、回归与质量门禁' },
  { name: '代码审查', description: '读 diff、找风险、给修改意见' },
  { name: '文档', description: '设计说明、使用说明与交付文档' },
]

type CreateStep = 'identity' | 'role' | 'custom'

/** Static ledger surface; creation runs through the injected seam. */
export function CadrePanel({ createRosterEntry, createPlainSession }: PropsRuntime<'main'> & InjectFace<CadrePanelInjected>) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [rosterState, setRosterState] = useState<RosterState>({ kind: 'loading' })
  const [projectOpen, setProjectOpen] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createStep, setCreateStep] = useState<CreateStep>('identity')
  const [createRole, setCreateRole] = useState<RosterRole>('worker')
  const [roleChoice, setRoleChoice] = useState('')
  const [customName, setCustomName] = useState('')
  const [customDesc, setCustomDesc] = useState('')
  const [customRoles, setCustomRoles] = useState<readonly CustomRole[]>(() => loadCustomRoles())
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [retireFor, setRetireFor] = useState<RosterMember | null>(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [employee, setEmployee] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'danger' | 'neutral'; text: string } | null>(null)
  const [acceptFor, setAcceptFor] = useState<string | null>(null)
  const [bindOpen, setBindOpen] = useState(false)
  const [bindProviders, setBindProviders] = useState<readonly {
    providerId: string
    name: string
    defaultModel: string
    models?: readonly { id: string }[]
  }[]>([])
  const [bindProviderId, setBindProviderId] = useState('')
  const [bindModel, setBindModel] = useState('')
  const [bindNotice, setBindNotice] = useState<string | null>(null)
  const [reasonFor, setReasonFor] = useState<{ taskId: string; status: 'rework' | 'failed' } | null>(null)
  const [reason, setReason] = useState('')

  const canDispatch = typeof window.cadre?.dispatchTask === 'function'
  const canTransition = typeof window.cadre?.transitionTask === 'function'

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    setRosterState({ kind: 'loading' })
    const bridge = window.cadre
    if (bridge === undefined) {
      setState({ kind: 'fallback', reason: '主进程通道未就绪' })
      setRosterState({ kind: 'error', reason: '主进程通道未就绪' })
      return
    }
    let rows: CadreTaskRow[] = []
    try {
      const result = await bridge.listTasks({ projectId: PROJECT_ID })
      rows = [...result.rows]
      setState(previous => ({
        kind: 'ready',
        tasks: rows.map(row => toViewTask(
          row,
          previous.kind === 'ready' ? previous.tasks.find(task => task.taskId === row.taskId) : undefined,
        )),
      }))
    } catch (error) {
      setState({ kind: 'fallback', reason: errorMessage(error) })
    }
    // One adapter call owns roster fetching; task statuses sharpen its states.
    const roster = await loadRoster(bridge, PROJECT_ID, rows)
    setRosterState(roster.ok
      ? { kind: 'ready', members: roster.members }
      : { kind: 'error', reason: roster.reason })
  }, [])

  useEffect(() => { void load() }, [load])

  // Apply the rows a write already read back. The write connection returns the
  // base row shape (no report join), so merge by taskId to keep W3 cards intact;
  // the delayed fresh read then replaces them with the full projection.
  const applyWriteResult = (result: { tasks?: CadreTaskRow[] } | undefined) => {
    if (result?.tasks === undefined) return
    setState(previous => ({
      kind: 'ready',
      tasks: result.tasks?.map(row => toViewTask(
        row,
        previous.kind === 'ready' ? previous.tasks.find(task => task.taskId === row.taskId) : undefined,
      )) ?? [],
    }))
  }

  const submitDispatch = async () => {
    const bridge = window.cadre
    if (bridge === undefined) {
      setNotice({ tone: 'danger', text: '主进程通道未就绪' })
      return
    }
    if (bridge.dispatchTask === undefined) {
      setNotice({ tone: 'danger', text: '写入通道待接入：cadre:dispatchTask 尚未注册' })
      return
    }
    if (employee.trim() === '' || title.trim() === '') {
      setNotice({ tone: 'danger', text: '请填写员工与标题' })
      return
    }
    setPending(true)
    setNotice(null)
    try {
      const result = await bridge.dispatchTask({
        projectId: PROJECT_ID,
        assigneeSessionId: employee.trim(),
        title: title.trim(),
        body,
      })
      if (!writeSucceeded(result)) {
        // Keep the form open for retry and the list untouched: the ledger did
        // not confirm the write.
        setNotice({ tone: 'danger', text: writeFailure(result) })
        return
      }
      applyWriteResult(result)
      setDispatchOpen(false)
      setEmployee('')
      setTitle('')
      setBody('')
      // Reconcile after the write's rows are on screen; an immediate second read
      // can still observe the previous WAL snapshot and overwrite the result.
      window.setTimeout(() => { void load() }, 2000)
      setNotice({ tone: 'neutral', text: '已派发，列表已刷新' })
    } catch (error) {
      setNotice({ tone: 'danger', text: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  const submitTransition = async (taskId: string, status: TransitionStatus, reasonText?: string) => {
    const bridge = window.cadre
    if (bridge?.transitionTask === undefined) {
      setNotice({ tone: 'danger', text: '写入通道待接入：cadre:transitionTask 尚未注册' })
      return
    }
    setPending(true)
    setNotice(null)
    const finish = (final: TransitionStatus) => {
      setReasonFor(null)
      setReason('')
      window.setTimeout(() => { void load() }, 2000)
      const done: Record<TransitionStatus, string> = {
        review: '主管审核已通过，等待用户确认',
        verified: '用户已确认，任务完成',
        rework: '已打回重做，等待员工继续',
        failed: '已标记失败',
      }
      setNotice({ tone: 'neutral', text: done[final] })
    }
    try {
      const current = state.kind === 'ready'
        ? state.tasks.find(task => task.taskId === taskId)
        : undefined
      // The ledger requires review to be a mandatory stop: delivered cannot go
      // straight to rework/failed. A supervisor rejection therefore records the
      // review step first, then the verdict; a failure in the second call is
      // reported as a partial result rather than as success.
      if (current?.status === 'delivered' && (status === 'rework' || status === 'failed')) {
        const reviewed = await bridge.transitionTask({ projectId: PROJECT_ID, taskId, status: 'review' })
        if (!writeSucceeded(reviewed)) {
          setNotice({ tone: 'danger', text: writeFailure(reviewed) })
          return
        }
        applyWriteResult(reviewed)
        const verdict = await bridge.transitionTask({
          projectId: PROJECT_ID,
          taskId,
          status,
          ...(reasonText === undefined || reasonText.trim() === '' ? {} : { reason: reasonText.trim() }),
        })
        if (!writeSucceeded(verdict)) {
          setNotice({
            tone: 'danger',
            text: `已进入待用户确认，但${status === 'rework' ? '打回' : '标记失败'}失败：${writeFailure(verdict)}`,
          })
          return
        }
        applyWriteResult(verdict)
        finish(status)
        return
      }
      const result = await bridge.transitionTask({
        projectId: PROJECT_ID,
        taskId,
        status,
        ...(reasonText === undefined || reasonText.trim() === '' ? {} : { reason: reasonText.trim() }),
      })
      if (!writeSucceeded(result)) {
        setNotice({ tone: 'danger', text: writeFailure(result) })
        return
      }
      applyWriteResult(result)
      finish(status)
    } catch (error) {
      setNotice({ tone: 'danger', text: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  const onTransition = (taskId: string, status: TransitionStatus) => {
    if (status === 'review' || status === 'verified') {
      void submitTransition(taskId, status)
      return
    }
    // rework / failed are reason-required by the ledger's transition matrix.
    setReasonFor({ taskId, status })
    setReason('')
  }

  const openBind = async () => {
    setBindOpen(true)
    setBindNotice(null)
    setBindProviderId('')
    setBindModel('')
    const list = window.cadre?.listProviders
    if (list === undefined) {
      setBindProviders([])
      setBindNotice('会话绑定通道待接入：window.cadre.bindSession 未注册')
      return
    }
    try {
      const result = await list()
      setBindProviders(result?.providers ?? [])
    } catch (cause) {
      setBindNotice(errorMessage(cause))
    }
  }

  const submitBind = async () => {
    const bind = window.cadre?.bindSession
    if (bind === undefined) {
      setBindNotice('会话绑定通道待接入：window.cadre.bindSession 未注册')
      return
    }
    if (bindProviderId === '') {
      setBindNotice('请选择 Provider')
      return
    }
    const selected = bindProviders.find(provider => provider.providerId === bindProviderId)
    try {
      const result = await bind({
        projectId: PROJECT_ID,
        providerId: bindProviderId,
        model: bindModel.trim() === '' ? selected?.defaultModel ?? '' : bindModel.trim(),
      })
      if (result?.ok === false) {
        setBindNotice(`${result.code ?? 'ERROR'} · ${result.message ?? '绑定失败'}`)
        return
      }
      setBindOpen(false)
      setNotice({ tone: 'neutral', text: '会话模型已绑定' })
    } catch (cause) {
      setBindNotice(errorMessage(cause))
    }
  }

  const offline = state.kind === 'fallback'
  const tasks = state.kind === 'ready'
    ? state.tasks
    : offline ? SAMPLE_TASKS : []
  // W3 cards cover every task that reached a report/review state; newest
  // report first so a burst of employee reports reads top-down.
  const reportTasks = state.kind === 'ready'
    ? state.tasks
      .filter(task => task.report !== undefined
        || task.status === 'delivered' || task.status === 'review'
        || task.status === 'rework' || task.status === 'verified')
      .sort((left, right) => {
        const at = Date.parse(left.report?.receivedAt ?? left.updatedAt ?? '')
        const bt = Date.parse(right.report?.receivedAt ?? right.updatedAt ?? '')
        return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
      })
    : []
  const workers: readonly RosterMember[] = rosterState.kind === 'ready'
    ? rosterState.members.filter(member => member.role === 'worker')
    : []
  const supervisor = rosterState.kind === 'ready'
    ? rosterState.members.find(member => member.role === 'supervisor' && member.status !== 'departed')
    : undefined
  const acceptTask = acceptFor === null ? undefined : tasks.find(task => task.taskId === acceptFor)
  // Two visible stages so the operator knows which level they are acting on;
  // the ledger status is the source of truth, not local UI state.
  const acceptStage: 'review' | 'confirm' = acceptTask?.status === 'review' ? 'confirm' : 'review'

  const openCreate = () => {
    setNotice(null)
    setCreateError(null)
    setCreateStep('identity')
    setCreateRole('worker')
    setRoleChoice('')
    setCustomName('')
    setCustomDesc('')
    setCustomRoles(loadCustomRoles())
    setCreateOpen(true)
  }

  const submitCreate = async (displayName: string, description?: string) => {
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createRosterEntry({
        role: createRole,
        displayName,
        ...(description === undefined || description.trim() === '' ? {} : { description: description.trim() }),
      })
      if (!result.ok) {
        setCreateError(`${result.code} · ${result.message}`)
        return
      }
      setCreateOpen(false)
      await load()
      setNotice({ tone: 'neutral', text: `已创建${createRole === 'supervisor' ? '主管' : '员工'}，花名册已刷新` })
    } finally {
      setCreating(false)
    }
  }

  const submitCustomRole = async () => {
    const name = customName.trim()
    const description = customDesc.trim()
    if (name === '') {
      setCreateError('请填写角色名称')
      return
    }
    if (description.length > 500) {
      setCreateError('角色职责最多 500 字')
      return
    }
    const next = saveCustomRole({ id: `role-${String(Date.now())}`, name, description })
    setCustomRoles(next)
    await submitCreate(name, description)
  }

  const retire = async (member: RosterMember) => {
    const bridge = window.cadre
    if (bridge?.retireMember === undefined) {
      setNotice({ tone: 'danger', text: '离职通道待接入：cadre:retireMember 未注册' })
      return
    }
    setPending(true)
    setNotice(null)
    try {
      const result = await bridge.retireMember({ projectId: PROJECT_ID, sessionId: member.sessionId })
      if (result?.ok === false) {
        setNotice({ tone: 'danger', text: `${result.code ?? 'ERROR'} · ${result.message ?? '离职失败'}` })
        return
      }
      setRetireFor(null)
      await load()
      setNotice({ tone: 'neutral', text: `${member.name} 已离职，历史保留` })
    } catch (error) {
      setNotice({ tone: 'danger', text: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  const createPlain = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createPlainSession()
      if (!result.ok) {
        setCreateError(`${result.code} · ${result.message}`)
        return
      }
      setCreateOpen(false)
      setNotice({ tone: 'neutral', text: `已新建会话 ${result.sessionId}` })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h1 style={{ margin: 0, flex: 1, color: TEXT_PRIMARY }}>项目</h1>
        {offline && <Tag tone="neutral">离线示例数据</Tag>}
        {!canDispatch && <Tag tone="neutral">写入通道待接入</Tag>}
        <Button variant="outline" size="sm" onClick={() => { void openBind() }}>
          会话模型
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { setNotice(null); setDispatchOpen(true) }}
        >
          派活
        </Button>
      </div>

      {/* W8: 工作区（容器）→ 项目（文件夹）→ 花名册。The project row owns the
          only creation entry; the roster never surfaces a global one. */}
      <div role="tree" aria-label="工作区与项目" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <span style={{ color: TEXT_SECONDARY, fontSize: 12, fontWeight: 600 }}>默认工作区</span>
          <span style={{ color: TEXT_SECONDARY, fontSize: 11 }}>1 个项目</span>
          <span style={{ flex: 1, height: 1, background: 'var(--dsw-alias-border-l1)' }} />
        </div>
        <div role="treeitem" aria-expanded={projectOpen} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
          <Button variant="outline" size="sm" onClick={() => { setProjectOpen(open => !open) }}>
            {projectOpen ? '▾' : '▸'}
          </Button>
          <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>{PROJECT_ID}</span>
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
            {state.kind === 'fallback' ? '台账不可用' : '当前项目'}
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant="outline"
            size="sm"
            aria-label="新建"
            title="新建会话 / 新建员工 / 新建主管"
            onClick={openCreate}
          >
            ＋
          </Button>
        </div>
      </div>

      {projectOpen && (
        <div style={{ paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <CadreRoster
            state={rosterState}
            onRetry={() => { void load() }}
            onRetire={member => { setNotice(null); setRetireFor(member) }}
          />
        </div>
      )}

      <p style={{ margin: 0, color: TEXT_SECONDARY }}>
        {state.kind === 'ready'
          ? `台账 · 项目 ${PROJECT_ID}`
          : `台账 · 项目 ${PROJECT_ID} · ${state.kind === 'fallback' ? state.reason : '读取中'}`}
      </p>

      {notice !== null && (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          style={{ margin: 0, color: notice.tone === 'danger' ? TEXT_ERROR : TEXT_SECONDARY }}
        >
          {notice.text}
        </p>
      )}

      <div style={{ height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 0 8px' }} />

      {state.kind === 'loading' && (
        <div role="status" aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0' }}>
          <StateDot state="ongoing" />
          <span>读取台账…</span>
        </div>
      )}

      {state.kind === 'ready' && tasks.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 14, color: TEXT_PRIMARY }}>汇报</h2>
            <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{reportTasks.length} 条</span>
          </div>
          {reportTasks.length === 0
            ? (
              <p role="status" style={{ margin: 0, color: TEXT_SECONDARY }}>
                暂无汇报。员工调用 report_task 回报后，任务会出现在这里等待验收。
              </p>
            )
            : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {reportTasks.map(task => (
                  <ReportCard
                    key={task.taskId}
                    task={task}
                    onReview={(taskId) => { setNotice(null); setAcceptFor(taskId) }}
                  />
                ))}
              </ul>
            )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <h2 style={{ margin: 0, fontSize: 14, color: TEXT_PRIMARY }}>全部任务</h2>
            <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{tasks.length} 条</span>
          </div>
        </>
      )}

      {state.kind === 'ready' && tasks.length === 0 && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0' }}>
          <span>暂无任务</span>
          <span>当前项目还没有可展示的台账行。</span>
          <div><Button variant="outline" size="sm" onClick={() => { void load() }}>刷新</Button></div>
        </div>
      )}

      {(state.kind === 'ready' || offline) && tasks.length > 0 && (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {tasks.map(task => (
              <TaskRow key={task.taskId} task={task} onAccept={(taskId) => { setNotice(null); setAcceptFor(taskId) }} />
            ))}
          </ul>
          {offline && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>以上为离线示例数据，不代表真实台账。</span>
              <Button variant="outline" size="sm" onClick={() => { void load() }}>重试</Button>
            </div>
          )}
        </>
      )}

      <Modal
        open={createOpen}
        onClose={() => { setCreateOpen(false) }}
        title={createStep === 'identity' ? '新建 · 选身份' : createStep === 'role' ? '新建 · 选职能' : '新建 · 自定义角色'}
        description={`项目 ${PROJECT_ID} · 新建内容只属于当前项目`}
        closeLabel="关闭"
        footer={(
          <>
            {createStep !== 'identity' && (
              <Button
                variant="outline"
                disabled={creating}
                onClick={() => { setCreateError(null); setCreateStep(createStep === 'custom' ? 'role' : 'identity') }}
              >
                上一步
              </Button>
            )}
            <Button variant="outline" onClick={() => { setCreateOpen(false) }}>取消</Button>
            {createStep === 'role' && (
              <Button
                variant="primary"
                disabled={creating || roleChoice === ''}
                onClick={() => {
                  const builtin = BUILTIN_ROLES.find(role => role.name === roleChoice)
                  const saved = customRoles.find(role => role.name === roleChoice)
                  void submitCreate(roleChoice, builtin?.description ?? saved?.description)
                }}
              >
                创建
              </Button>
            )}
            {createStep === 'custom' && (
              <Button variant="primary" disabled={creating} onClick={() => { void submitCustomRole() }}>
                保存并创建
              </Button>
            )}
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {createStep === 'identity' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Button variant="outline" disabled={creating} onClick={() => { setCreateRole('worker'); setCreateStep('role') }}>
                  员工
                </Button>
                <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>接收派活、动手做事。</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Button
                  variant="outline"
                  disabled={creating || supervisor !== undefined}
                  title={supervisor !== undefined ? '本项目已有主管，请先到该会话办理离职' : '主管'}
                  onClick={() => { setCreateRole('supervisor'); setCreateStep('role') }}
                >
                  主管
                </Button>
                <span role={supervisor !== undefined ? 'status' : undefined} style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                  {supervisor !== undefined
                    ? `本项目已有主管（${supervisor.name}），请先到该会话办理离职。`
                    : '只读调度：派活、催办、先审交付，不直接改文件。'}
                </span>
              </div>
              <div style={{ height: 1, background: 'var(--dsw-alias-border-l1)' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Button variant="outline" disabled={creating} onClick={() => { void createPlain() }}>新建会话</Button>
                <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>普通会话，不做员工登记。</span>
              </div>
              {createError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{createError}</p>}
            </>
          )}

          {createStep === 'role' && (
            <>
              <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                {createRole === 'supervisor' ? '主管也选一个职能，便于说明它擅长调度什么。' : '选一张职能卡；不选模型。'}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {BUILTIN_ROLES.map(role => (
                  <Button
                    key={role.name}
                    variant={roleChoice === role.name ? 'primary' : 'outline'}
                    onClick={() => { setRoleChoice(role.name) }}
                  >
                    {role.name} · {role.description}
                  </Button>
                ))}
                {customRoles.map(role => (
                  <div key={role.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Button
                      variant={roleChoice === role.name ? 'primary' : 'outline'}
                      onClick={() => { setRoleChoice(role.name) }}
                    >
                      {role.name}（自定义）· {role.description}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`删除自定义角色 ${role.name}`}
                      title="删除这个自定义角色（不影响已创建的员工）"
                      onClick={() => { setCustomRoles(removeCustomRole(role.id)) }}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button variant="outline" onClick={() => { setCreateStep('custom') }}>自定义角色…</Button>
              </div>
              {createError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{createError}</p>}
            </>
          )}

          {createStep === 'custom' && (
            <>
              <label htmlFor="cadre-custom-name">角色名称</label>
              <Input
                id="cadre-custom-name"
                value={customName}
                placeholder="例如：数据工程"
                disabled={creating}
                onChange={event => { setCustomName(event.target.value) }}
              />
              <label htmlFor="cadre-custom-desc">这个角色负责什么（最多 500 字）</label>
              <textarea
                id="cadre-custom-desc"
                value={customDesc}
                placeholder="写清职责与边界；保存后会在下次新建时出现在角色列表里。"
                rows={5}
                maxLength={500}
                disabled={creating}
                onChange={event => { setCustomDesc(event.target.value) }}
                style={BODY_TEXTAREA}
              />
              <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>保存的自定义角色可复用，也可在列表里删除。</span>
              {createError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{createError}</p>}
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={retireFor !== null}
        onClose={() => { setRetireFor(null) }}
        title={retireFor?.role === 'supervisor' ? '主管离职' : '员工离职'}
        {...(retireFor !== null ? { description: `${retireFor.name} · 项目 ${PROJECT_ID}` } : {})}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRetireFor(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => { if (retireFor !== null) void retire(retireFor) }}
            >
              确认离职
            </Button>
          </>
        )}
      >
        <p style={{ margin: 0, color: TEXT_SECONDARY }}>
          离职后从在职花名册移除，进入「已离职」只读列表；会话与历史任务保留
          {retireFor?.role === 'supervisor' ? '，本项目随后可以新建主管。' : '。'}
        </p>
      </Modal>

      <Modal
        open={dispatchOpen}
        onClose={() => { setDispatchOpen(false) }}
        title="派活"
        description={`项目 ${PROJECT_ID} · 以主管身份派发`}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDispatchOpen(false) }}>取消</Button>
            <Button variant="primary" disabled={pending} onClick={() => { void submitDispatch() }}>派发</Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label htmlFor="cadre-employee">员工</label>
          <Input
            id="cadre-employee"
            value={employee}
            onChange={event => { setEmployee(event.target.value) }}
            placeholder={workers.length > 0 ? '选择或输入员工 sessionId' : '输入员工 sessionId'}
            disabled={pending}
          />
          {workers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {workers.map(member => (
                <Button
                  key={member.sessionId}
                  variant="outline"
                  size="sm"
                  onClick={() => { setEmployee(member.sessionId) }}
                >
                  {member.name}
                </Button>
              ))}
            </div>
          )}
          <label htmlFor="cadre-title">标题</label>
          <Input
            id="cadre-title"
            value={title}
            onChange={event => { setTitle(event.target.value) }}
            placeholder="一句话说明要做的事"
            disabled={pending}
          />
          <label htmlFor="cadre-body">正文</label>
          <textarea
            id="cadre-body"
            value={body}
            onChange={event => { setBody(event.target.value) }}
            placeholder="任务详情、验收标准、参考文件…"
            rows={5}
            disabled={pending}
            style={BODY_TEXTAREA}
          />
          {!canDispatch && <p style={{ margin: 0, color: TEXT_SECONDARY }}>写入通道待接入，当前仅可预览表单。</p>}
        </div>
      </Modal>

      <Modal
        open={bindOpen}
        onClose={() => { setBindOpen(false) }}
        title="会话模型"
        description={`项目 ${PROJECT_ID} · 绑定后由主进程决定身份`}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setBindOpen(false) }}>取消</Button>
            <Button variant="primary" onClick={() => { void submitBind() }}>绑定</Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {bindProviders.length === 0 && (
            <p style={{ margin: 0, color: TEXT_SECONDARY }}>暂无可用 Provider，请先在设置 → 模型 Providers 中添加。</p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {bindProviders.map(provider => (
              <Button
                key={provider.providerId}
                variant={bindProviderId === provider.providerId ? 'primary' : 'outline'}
                size="sm"
                onClick={() => {
                  setBindProviderId(provider.providerId)
                  setBindModel(provider.defaultModel)
                }}
              >
                {provider.name}
              </Button>
            ))}
          </div>
          <label htmlFor="bind-model">模型</label>
          <Input
            id="bind-model"
            value={bindModel}
            placeholder="默认使用 Provider 的默认模型"
            onChange={event => { setBindModel(event.target.value) }}
          />
          {bindNotice !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{bindNotice}</p>}
        </div>
      </Modal>

      <Modal
        open={acceptFor !== null}
        onClose={() => { setAcceptFor(null) }}
        title={acceptStage === 'confirm' ? '验收 · 用户确认' : '验收 · 主管审核'}
        {...(acceptTask !== undefined ? { description: `${acceptTask.assignee} · ${acceptTask.title}` } : {})}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setAcceptFor(null) }}>取消</Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                const taskId = acceptFor
                setAcceptFor(null)
                if (taskId !== null) onTransition(taskId, 'rework')
              }}
            >
              打回重做
            </Button>
            {acceptStage === 'confirm' && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  const taskId = acceptFor
                  setAcceptFor(null)
                  if (taskId !== null) onTransition(taskId, 'failed')
                }}
              >
                标记失败
              </Button>
            )}
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                const taskId = acceptFor
                setAcceptFor(null)
                if (taskId !== null) onTransition(taskId, acceptStage === 'confirm' ? 'verified' : 'review')
              }}
            >
              {acceptStage === 'confirm' ? '用户确认通过' : '主管审核通过'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tag tone="neutral">{`① 主管审核${acceptStage === 'confirm' ? ' ✓' : ''}`}</Tag>
            <Tag tone="neutral">{`② 用户确认${acceptStage === 'confirm' ? '（当前）' : ''}`}</Tag>
          </div>
          {acceptTask?.report !== undefined && (
            <>
              <p style={{ margin: 0, color: TEXT_PRIMARY }}>{firstSentence(acceptTask.report.summary)}</p>
              <div style={{ color: TEXT_SECONDARY, fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span>交付物</span>
                {acceptTask.report.deliverables.length === 0
                  ? <span>（未提供）</span>
                  : acceptTask.report.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
              </div>
            </>
          )}
          <p style={{ margin: 0, color: TEXT_SECONDARY }}>
            {acceptStage === 'review'
              ? '通过后进入「待用户确认」；打回须填写一句原因。'
              : '确认通过后任务完成；打回须填写一句原因。'}
          </p>
          {!canTransition && <p style={{ margin: 0, color: TEXT_SECONDARY }}>写入通道待接入，当前仅可预览操作。</p>}
        </div>
      </Modal>

      <Modal
        open={reasonFor !== null}
        onClose={() => { setReasonFor(null) }}
        title={reasonFor?.status === 'failed' ? '标记失败' : '退回重做'}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setReasonFor(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={pending || reason.trim() === ''}
              onClick={() => {
                if (reasonFor !== null) void submitTransition(reasonFor.taskId, reasonFor.status, reason)
              }}
            >
              确认
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label htmlFor="cadre-reason">原因</label>
          <textarea
            id="cadre-reason"
            value={reason}
            onChange={event => { setReason(event.target.value) }}
            placeholder="说明退回或失败的原因"
            rows={4}
            disabled={pending}
            style={BODY_TEXTAREA}
          />
        </div>
      </Modal>
    </div>
  )
}
