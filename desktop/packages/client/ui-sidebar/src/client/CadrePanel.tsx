/**
 * Cadre collaboration panel.
 *
 * Reads the desktop bridge `window.cadre.listTasks` when available and falls
 * back to labelled sample rows otherwise. Write actions (dispatch / acceptance)
 * call the bridge when the main process registers them; until then the forms
 * stay interactive and report the missing channel instead of pretending success.
 * Only shipped primitives and inline layout are used; no custom palette.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Button,
  Checkbox,
  IconBranchOutlineRegular,
  Input,
  Menu,
  Modal,
  Pill,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  readonly assigneeTitle?: string
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
  readonly assigneeTitle?: string
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
    sessionId: string
    providerId: string
    model: string
  }): Promise<{ ok?: boolean; code?: string; message?: string } | undefined>
  listProviders?(): Promise<{
    ok?: boolean
    providers?: readonly CadreProviderOption[]
  }>
}

interface CadreProviderOption {
  readonly providerId: string
  readonly name: string
  readonly defaultModel: string
  readonly models?: readonly { readonly id: string }[]
  readonly enabled?: boolean
  readonly hasKey?: boolean
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

/** A create request raised by the sidebar's New Session menu. */
export interface CadreCreateRequest {
  readonly kind: 'supervisor' | 'worker'
  readonly token: number
}

/** Injected creation seam: the plugin creates the official Session, then the member row. */
export interface CadrePanelInjected {
  createRosterEntry(input: {
    role: RosterRole
    displayName: string
    description?: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }>
  createPlainSession(): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }>
  openSession(sessionId: string): void
  hooks: { readonly createRequest: HostObservable<CadreCreateRequest | null> }
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

/** Ledger role used when the roster carries no free-text position. */
function roleLabel(role: string | undefined): string {
  return role === 'supervisor' ? '主管' : '员工'
}

/** 岗位名: the roster's description when present, otherwise the role label. */
function positionLabel(task: CadreTask): string {
  const title = task.assigneeTitle?.trim()
  return title === undefined || title === '' ? roleLabel(task.assigneeRole) : title
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
  const assigneeTitle = row.assigneeTitle ?? previous?.assigneeTitle
  const updatedAt = row.updatedAt ?? previous?.updatedAt
  const report = row.latestReport ?? previous?.report
  return {
    taskId: row.taskId,
    title: row.title,
    status: row.status,
    assignee: row.assigneeName?.trim() || previous?.assignee || row.assigneeSessionId,
    ...(assigneeTitle === undefined ? {} : { assigneeTitle }),
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
      <span>{`${task.assignee} · ${positionLabel(task)}`}</span>
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
        <Tag tone="neutral">{`${task.assignee} · ${positionLabel(task)}`}</Tag>
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

/** Role template group: the dialog lists one group at a time. */
type RoleGroup = 'dev' | 'novel' | 'general'

interface RoleTemplate {
  readonly id: string
  readonly name: string
  readonly duty: string
}

const ROLE_GROUPS: readonly { readonly id: RoleGroup; readonly label: string }[] = [
  { id: 'dev', label: '软件开发' },
  { id: 'novel', label: '小说' },
  { id: 'general', label: '通用' },
]

/**
 * Role templates (product-model §4). Picking one fills the name and duty; the
 * duty text is the employee prompt the Host injects at each step, so it states
 * the job and its boundary rather than a tool list.
 */
const ROLE_TEMPLATES: Readonly<Record<RoleGroup, readonly RoleTemplate[]>> = {
  dev: [
    { id: 'dev-backend', name: '后端', duty: '负责服务端接口、数据模型与业务逻辑。先读现有约定再改，保持兼容并可测试；交付时说明接口变更与验证方式。' },
    { id: 'dev-frontend', name: '前端', duty: '负责界面与交互实现。复用既有组件与设计令牌，覆盖加载、空与错误状态；交付时附关键截图与自测结论。' },
    { id: 'dev-test', name: '测试', duty: '负责用例设计、执行与回归。覆盖正常与边界路径，定位失败根因并给出可复现步骤，不为通过而修改产品代码。' },
    { id: 'dev-review', name: '代码审查', duty: '负责审查改动的正确性、安全性与可维护性。指出具体文件与行号，区分必须修改与建议，不替作者直接重写。' },
    { id: 'dev-design', name: '设计师', duty: '负责交互与视觉方案。基于现有设计体系给出可落地的布局、状态与文案，交付可实现规格而不是概念图。' },
    { id: 'dev-docs', name: '技术文档', duty: '负责设计说明、使用指南与交付记录。以代码与实测为依据，写清结论、证据与未验证项，保持术语一致。' },
    { id: 'dev-ops', name: '运维脚本', duty: '负责构建、部署与排障脚本。优先幂等与可回滚，危险操作必须显式确认并保留日志，不擅自修改共享配置。' },
    { id: 'dev-ue', name: '虚幻引擎开发', duty: '负责 UE 蓝图、C++ 与资源集成。遵循项目现有模块划分与性能预算，交付可复现的构建与运行步骤。' },
    { id: 'dev-architect', name: '架构师', duty: '负责边界划分、接口契约与技术取舍。先给约束、备选与代价，再落最小改动，避免为假设中的未来过度设计。' },
  ],
  novel: [
    { id: 'novel-writer', name: '写作', duty: '负责章节正文创作。保持人物口吻与叙事节奏一致，按大纲推进，交付成稿并标注本次修改点。' },
    { id: 'novel-plot', name: '故事策划', duty: '负责世界观、主线与章节大纲。给出冲突推进与人物弧光，明确取舍，不直接代写正文。' },
    { id: 'novel-lore', name: '设定编辑', duty: '负责设定库与一致性校验。维护人物、地点与时间线，发现矛盾先列证据再改，不擅自推翻既有设定。' },
    { id: 'novel-copyedit', name: '文字编辑', duty: '负责润色与校对。统一语体、修正语病与标点，保留作者风格，交付修改说明而不是静默改写。' },
    { id: 'novel-art', name: '绘画师', duty: '负责插画与视觉设定。按文本气质确定构图、色彩与风格，交付可追溯的素材与使用说明。' },
    { id: 'novel-translate', name: '翻译', duty: '负责中英互译与术语统一。忠于原意并保留语气，建立专名对照表，交付双语对照稿。' },
  ],
  general: [
    { id: 'general-plan', name: '策划', duty: '负责把目标拆成可执行方案。给出范围、步骤、依赖与验收标准，标明假设与风险，不空谈方向。' },
    { id: 'general-research', name: '资料整理', duty: '负责检索、筛选与归纳资料。标注来源与时间，区分事实与推测，交付结构化摘要与原始链接。' },
    { id: 'general-proposal', name: '方案撰写', duty: '负责把需求写成可评审的方案。结论先行，论据可核查，列出备选与代价，控制篇幅。' },
    { id: 'general-quality', name: '质量检查', duty: '负责按清单核验交付物。逐项给出通过或不通过及证据，发现缺口直接指出，不用口头保证代替检查。' },
    { id: 'general-coord', name: '协作协调', duty: '负责对齐任务边界与进度。记录谁在做什么、卡在哪里，及时升级冲突，不替他人做专业决策。' },
  ],
}

/** Menu rows for the project-row ＋ and the sidebar New Session button. */
const CREATE_ITEMS = [
  { id: 'supervisor', label: '主管' },
  { id: 'worker', label: '员工' },
  { id: 'plain', label: '普通会话' },
] as const

/** Static ledger surface; creation runs through the injected seam. */
export function CadrePanel({
  createRosterEntry, createPlainSession, openSession, useCreateRequest, useSessions,
}: PropsRuntime<'main'> & InjectFace<CadrePanelInjected>) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [rosterState, setRosterState] = useState<RosterState>({ kind: 'loading' })
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [createKind, setCreateKind] = useState<'supervisor' | 'worker' | null>(null)
  const [supervisorName, setSupervisorName] = useState('')
  const [workerName, setWorkerName] = useState('')
  const [workerDuty, setWorkerDuty] = useState('')
  const [templateGroup, setTemplateGroup] = useState<RoleGroup>('dev')
  const [templateId, setTemplateId] = useState('')
  const [saveAsCustom, setSaveAsCustom] = useState(false)
  const [customRoles, setCustomRoles] = useState<readonly CustomRole[]>(() => loadCustomRoles())
  const [providers, setProviders] = useState<readonly CadreProviderOption[]>([])
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [retireFor, setRetireFor] = useState<RosterMember | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'danger' | 'neutral'; text: string } | null>(null)
  const [acceptFor, setAcceptFor] = useState<string | null>(null)
  const [reasonFor, setReasonFor] = useState<{ taskId: string; status: 'rework' | 'failed' } | null>(null)
  const [reason, setReason] = useState('')

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
  const supervisor = rosterState.kind === 'ready'
    ? rosterState.members.find(member => member.role === 'supervisor' && member.status !== 'departed')
    : undefined
  const acceptTask = acceptFor === null ? undefined : tasks.find(task => task.taskId === acceptFor)
  // Two visible stages so the operator knows which level they are acting on;
  // the ledger status is the source of truth, not local UI state.
  const acceptStage: 'review' | 'confirm' = acceptTask?.status === 'review' ? 'confirm' : 'review'

  // Ordinary sessions are top-level Sessions the roster does not own. Departed
  // employees stay out of this list through the roster's full session-id set.
  const sessionState = useSessions(snapshot => snapshot)
  const rosterSessionIds = new Set(rosterState.kind === 'ready'
    ? rosterState.members.map(member => member.sessionId)
    : [])
  const ordinarySessions = sessionState.ids
    .map(id => sessionState.byId[id])
    .filter((session): session is NonNullable<typeof session> =>
      session !== undefined
      && !session.blank
      && session.origin !== 'subagent'
      && session.parentId === undefined
      && !rosterSessionIds.has(session.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20)

  const openCreate = useCallback(async (kind: 'supervisor' | 'worker') => {
    setCreateMenuOpen(false)
    setNotice(null)
    setCreateError(null)
    setCreateKind(kind)
    setSupervisorName('')
    setWorkerName('')
    setWorkerDuty('')
    setTemplateId('')
    setTemplateGroup('dev')
    setSaveAsCustom(false)
    setCustomRoles(loadCustomRoles())
    setProviderId('')
    setModelId('')
    setProviders([])
    if (kind !== 'worker') return
    const list = window.cadre?.listProviders
    if (list === undefined) {
      setCreateError('服务商通道未接入：window.cadre.listProviders 未注册')
      return
    }
    try {
      const result = await list()
      const usable = (result?.providers ?? []).filter(provider => provider.enabled !== false)
      setProviders(usable)
      const first = usable[0]
      if (first !== undefined) {
        setProviderId(first.providerId)
        setModelId(first.defaultModel)
      }
    } catch (error) {
      setCreateError(`读取服务商失败：${errorMessage(error)}`)
    }
  }, [])

  // The sidebar's New Session menu dispatches through this store; the panel
  // owns the form, so the request only names the identity to create.
  const createRequest = useCreateRequest(snapshot => snapshot)
  const handledCreateToken = useRef(0)
  useEffect(() => {
    if (createRequest === null || createRequest.token === handledCreateToken.current) return
    handledCreateToken.current = createRequest.token
    void openCreate(createRequest.kind)
  }, [createRequest, openCreate])

  const applyTemplate = (template: RoleTemplate) => {
    setTemplateId(template.id)
    setWorkerName(template.name)
    setWorkerDuty(template.duty)
  }

  const submitWorker = async () => {
    const name = workerName.trim()
    const duty = workerDuty.trim()
    if (name === '') {
      setCreateError('请填写员工名称')
      return
    }
    if (duty === '') {
      setCreateError('请填写岗位职责')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createRosterEntry({ role: 'worker', displayName: name, description: duty })
      if (!result.ok) {
        setCreateError(`${result.code} · ${result.message}`)
        return
      }
      let modelNote = ''
      if (providerId !== '' && modelId !== '') {
        const bind = window.cadre?.bindSession
        if (bind === undefined) {
          modelNote = '；模型通道未接入，已使用默认模型'
        } else {
          try {
            const bound = await bind({ sessionId: result.sessionId, providerId, model: modelId })
            if (bound?.ok === false) {
              modelNote = `；模型未绑定（${bound.code ?? 'ERROR'} · ${bound.message ?? '未知错误'}）`
            }
          } catch (error) {
            modelNote = `；模型未绑定（${errorMessage(error)}）`
          }
        }
      }
      if (saveAsCustom) {
        setCustomRoles(saveCustomRole({ id: `role-${String(Date.now())}`, name, description: duty }))
      }
      setCreateKind(null)
      await load()
      setNotice({
        tone: modelNote === '' ? 'neutral' : 'danger',
        text: `已创建员工「${name}」，花名册已刷新${modelNote}`,
      })
    } finally {
      setCreating(false)
    }
  }

  const submitSupervisor = async () => {
    const name = supervisorName.trim()
    if (name === '') {
      setCreateError('请填写主管名字')
      return
    }
    if (supervisor !== undefined) {
      setCreateError(`本项目部已有主管（${supervisor.name}），请先让其离职`)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createRosterEntry({ role: 'supervisor', displayName: name })
      if (!result.ok) {
        setCreateError(`${result.code} · ${result.message}`)
        return
      }
      setCreateKind(null)
      await load()
      setNotice({ tone: 'neutral', text: `已创建主管「${name}」，花名册已刷新` })
    } finally {
      setCreating(false)
    }
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
    setCreateMenuOpen(false)
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createPlainSession()
      if (!result.ok) {
        setNotice({ tone: 'danger', text: `${result.code} · ${result.message}` })
        return
      }
      setNotice({ tone: 'neutral', text: `已新建会话 ${result.sessionId}` })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h1 style={{ margin: 0, color: TEXT_PRIMARY }}>项目部</h1>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{PROJECT_ID}</span>
        {offline && <Tag tone="neutral">离线示例数据</Tag>}
        <span style={{ flex: 1 }} />
        <Menu
          open={createMenuOpen}
          onClose={() => { setCreateMenuOpen(false) }}
          items={CREATE_ITEMS.map(item => item.id === 'supervisor' && supervisor !== undefined
            ? { ...item, disabled: true }
            : item)}
          onSelect={(id) => {
            if (id === 'plain') { void createPlain(); return }
            void openCreate(id === 'supervisor' ? 'supervisor' : 'worker')
          }}
          anchor={(
            <Button
              variant="outline"
              size="sm"
              aria-label="新建"
              title="主管 / 员工 / 普通会话"
              onClick={() => { setCreateMenuOpen(open => !open) }}
            >
              ＋
            </Button>
          )}
          portal
          closeOnPointerLeave
        />
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="花名册">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, color: TEXT_PRIMARY }}>花名册</h2>
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
            {rosterState.kind === 'ready' ? `${rosterState.members.filter(member => member.status !== 'departed').length} 人` : ''}
          </span>
        </div>
        <CadreRoster
          state={rosterState}
          onRetry={() => { void load() }}
          onRetire={member => { setNotice(null); setRetireFor(member) }}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="会话">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, color: TEXT_PRIMARY }}>会话</h2>
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
            {sessionState.phase === 'pending' ? '读取中' : `${ordinarySessions.length} 个普通会话`}
          </span>
        </div>
        {ordinarySessions.length === 0
          ? (
            <p role="status" style={{ margin: 0, color: TEXT_SECONDARY }}>
              {sessionState.phase === 'pending' ? '读取会话…' : '暂无普通会话；普通会话不进花名册。'}
            </p>
          )
          : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {ordinarySessions.map(session => (
                <li key={session.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => { openSession(session.id) }}
                  >
                    {session.displayTitle}
                  </Button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <p style={{ margin: 0, color: TEXT_SECONDARY }}>
        {state.kind === 'ready'
          ? `台账 · 项目部 ${PROJECT_ID}`
          : `台账 · 项目部 ${PROJECT_ID} · ${state.kind === 'fallback' ? state.reason : '读取中'}`}
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: TEXT_PRIMARY }}>台账</h2>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{tasks.length} 条</span>
      </div>

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
          <span>当前项目部还没有可展示的台账行。</span>
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
        open={createKind !== null}
        onClose={() => { setCreateKind(null) }}
        title={createKind === 'supervisor' ? '新建主管' : '新建员工'}
        description={createKind === 'supervisor'
          ? `项目部 ${PROJECT_ID} · 主管只做调度与验收`
          : `项目部 ${PROJECT_ID} · 选模板自动填名称与职责，均可修改`}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreateKind(null) }}>取消</Button>
            {createKind === 'supervisor'
              ? (
                <Button
                  variant="primary"
                  disabled={creating || supervisorName.trim() === '' || supervisor !== undefined}
                  onClick={() => { void submitSupervisor() }}
                >
                  创建主管
                </Button>
              )
              : (
                <Button
                  variant="primary"
                  disabled={creating || workerName.trim() === '' || workerDuty.trim() === ''}
                  onClick={() => { void submitWorker() }}
                >
                  创建员工
                </Button>
              )}
          </>
        )}
      >
        {createKind === 'supervisor'
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label htmlFor="cadre-supervisor-name">名字</label>
              <Input
                id="cadre-supervisor-name"
                value={supervisorName}
                placeholder="例如：调度员"
                disabled={creating}
                onChange={event => { setSupervisorName(event.target.value) }}
              />
              <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                主管不选职能、不建模板；每个项目部最多一名。已有主管时需先让其离职。
              </span>
              {supervisor !== undefined && (
                <p role="status" style={{ margin: 0, color: TEXT_SECONDARY }}>
                  本项目部已有主管（{supervisor.name}），请先让其离职。
                </p>
              )}
              {createError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{createError}</p>}
            </div>
          )
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="角色类别">
                {ROLE_GROUPS.map(group => (
                  <Button
                    key={group.id}
                    variant={templateGroup === group.id ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => { setTemplateGroup(group.id) }}
                  >
                    {group.label} {ROLE_TEMPLATES[group.id].length}
                  </Button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="角色模板">
                {ROLE_TEMPLATES[templateGroup].map(template => (
                  <Button
                    key={template.id}
                    variant={templateId === template.id ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => { applyTemplate(template) }}
                  >
                    {template.name}
                  </Button>
                ))}
                {customRoles.map(role => (
                  <span key={role.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <Button
                      variant={templateId === role.id ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setTemplateId(role.id)
                        setWorkerName(role.name)
                        setWorkerDuty(role.description)
                      }}
                    >
                      {role.name}（自定义）
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
                  </span>
                ))}
              </div>

              <label htmlFor="cadre-worker-name">名称</label>
              <Input
                id="cadre-worker-name"
                value={workerName}
                placeholder="选模板后自动填入，可改"
                disabled={creating}
                onChange={event => { setWorkerName(event.target.value) }}
              />
              <label htmlFor="cadre-worker-duty">岗位职责（最多 2000 字）</label>
              <textarea
                id="cadre-worker-duty"
                value={workerDuty}
                placeholder="选模板后自动填入；这是运行时注入的员工提示词，可改。"
                rows={5}
                maxLength={2000}
                disabled={creating}
                onChange={event => { setWorkerDuty(event.target.value) }}
                style={BODY_TEXTAREA}
              />
              <Checkbox
                checked={saveAsCustom}
                label="保存为自定义角色，供下次复用"
                disabled={creating}
                onChange={setSaveAsCustom}
              />

              <div style={{ height: 1, background: 'var(--dsw-alias-border-l1)' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ color: TEXT_PRIMARY, fontSize: 13 }}>服务商与模型（可选）</span>
                {providers.length === 0
                  ? <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>未配置服务商，将使用官方默认模型。</span>
                  : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="服务商">
                      {providers.map(provider => (
                        <Button
                          key={provider.providerId}
                          variant={providerId === provider.providerId ? 'primary' : 'outline'}
                          size="sm"
                          onClick={() => {
                            setProviderId(provider.providerId)
                            setModelId(provider.defaultModel)
                          }}
                        >
                          {provider.name}
                        </Button>
                      ))}
                    </div>
                  )}
                {(() => {
                  const selected = providers.find(provider => provider.providerId === providerId)
                  const models = selected?.models ?? []
                  if (models.length === 0) return null
                  return (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="模型">
                      {models.map(model => (
                        <Button
                          key={model.id}
                          variant={modelId === model.id ? 'primary' : 'outline'}
                          size="sm"
                          onClick={() => { setModelId(model.id) }}
                        >
                          {model.id}
                        </Button>
                      ))}
                    </div>
                  )
                })()}
                <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                  权限默认完全权限。思考强度随模型默认；当前接口只持久化服务商与模型。
                </span>
              </div>
              {createError !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR }}>{createError}</p>}
            </div>
          )}
      </Modal>

      <Modal
        open={retireFor !== null}
        onClose={() => { setRetireFor(null) }}
        title={retireFor?.role === 'supervisor' ? '主管离职' : '员工离职'}
        {...(retireFor !== null ? { description: `${retireFor.name} · 项目部 ${PROJECT_ID}` } : {})}
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
          {retireFor?.role === 'supervisor' ? '，本项目部随后可以新建主管。' : '。'}
        </p>
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
