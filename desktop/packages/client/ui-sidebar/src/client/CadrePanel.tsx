/**
 * Cadre collaboration panel.
 *
 * Reads the desktop bridge `window.cadre.listTasks` when available and falls
 * back to labelled sample rows otherwise. Write actions (dispatch / acceptance)
 * call the bridge when the main process registers them; until then the forms
 * stay interactive and report the missing channel instead of pretending success.
 * Only shipped primitives and inline layout are used; no custom palette.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconBranchOutlineRegular,
  Input,
  Modal,
  Pill,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** One ledger row rendered by the panel. */
interface CadreTask {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assignee: string
}

/** Raw row shape of `cadre:listTasks` (assignee is a session id). */
interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
}

/** One roster member returned by `cadre:listRoster`. */
interface CadreMember {
  readonly sessionId: string
  readonly name?: string
}

/** Bridge surface. Write methods are optional until the main process ships them. */
interface CadreBridge {
  listTasks(query: { projectId: string }): Promise<{
    projectId: string
    rows: CadreTaskRow[]
    elapsedMs?: number
  }>
  listRoster?(query: { projectId: string }): Promise<{ members?: CadreMember[]; rows?: CadreMember[] }>
  dispatchTask?(query: {
    projectId: string
    assigneeSessionId: string
    title: string
    body: string
  }): Promise<{ tasks?: CadreTaskRow[] } | undefined>
  transitionTask?(query: {
    projectId: string
    taskId: string
    status: 'verified' | 'rework' | 'failed'
    reason?: string
  }): Promise<{ tasks?: CadreTaskRow[] } | undefined>
}

declare global {
  interface Window {
    cadre?: CadreBridge
  }
}

// Temporary project binding: replace with the launch configuration or the
// session's project id once the main process exposes it.
const PROJECT_ID = 'proj-demo'

const SAMPLE_TASKS: readonly CadreTask[] = [
  { taskId: 'task-101', title: '补齐 M3 验收矩阵', status: '已验收', assignee: '前端' },
  { taskId: 'task-102', title: '事件泵补发适配', status: '验收中', assignee: '前端' },
  { taskId: 'task-103', title: '默认中文与偏好回退', status: '已交付', assignee: '前端' },
  { taskId: 'task-104', title: '官方壳协作面板挂出', status: '进行中', assignee: '前端' },
]

/** Display labels for the ledger's status codes. */
const STATUS_LABELS: Record<string, string> = {
  delivered: '已交付',
  in_progress: '进行中',
  verified: '已验收',
  failed: '失败',
  cancelled: '已取消',
  rework: '退回重做',
}

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly tasks: readonly CadreTask[] }
  | { readonly kind: 'fallback'; readonly reason: string }

type TransitionStatus = 'verified' | 'rework' | 'failed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const delivered = task.status === 'delivered'
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
      <Tag tone="neutral">{task.taskId}</Tag>
      <span style={{ flex: 1 }}>{task.title}</span>
      <span>{task.assignee}</span>
      <Pill>{STATUS_LABELS[task.status] ?? task.status}</Pill>
      {delivered && (
        <Button variant="outline" size="sm" onClick={() => { onAccept(task.taskId) }}>
          验收
        </Button>
      )}
    </li>
  )
}

/** Static ledger surface; main-panel props are not used at milestone 1. */
export function CadrePanel(_props: PropsRuntime<'main'>) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [roster, setRoster] = useState<readonly CadreMember[]>([])
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [employee, setEmployee] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'danger' | 'neutral'; text: string } | null>(null)
  const [acceptFor, setAcceptFor] = useState<string | null>(null)
  const [reasonFor, setReasonFor] = useState<{ taskId: string; status: 'rework' | 'failed' } | null>(null)
  const [reason, setReason] = useState('')

  const canDispatch = typeof window.cadre?.dispatchTask === 'function'
  const canTransition = typeof window.cadre?.transitionTask === 'function'

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    const bridge = window.cadre
    if (bridge === undefined) {
      setState({ kind: 'fallback', reason: '主进程通道未就绪' })
      return
    }
    try {
      const result = await bridge.listTasks({ projectId: PROJECT_ID })
      setState({
        kind: 'ready',
        tasks: result.rows.map(row => ({
          taskId: row.taskId,
          title: row.title,
          status: row.status,
          assignee: row.assigneeSessionId,
        })),
      })
    } catch (error) {
      setState({ kind: 'fallback', reason: errorMessage(error) })
    }
  }, [])

  const loadRoster = useCallback(async () => {
    const listRoster = window.cadre?.listRoster
    if (listRoster === undefined) return
    try {
      const result = await listRoster({ projectId: PROJECT_ID })
      setRoster(result.members ?? result.rows ?? [])
    } catch {
      // Roster is optional; the free-form employee input stays available.
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRoster() }, [loadRoster])

  // Apply the rows a write already read back, then reconcile with a fresh read.
  const applyWriteResult = (result: { tasks?: CadreTaskRow[] } | undefined) => {
    if (result?.tasks === undefined) return
    setState({
      kind: 'ready',
      tasks: result.tasks.map(row => ({
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        assignee: row.assigneeSessionId,
      })),
    })
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
      applyWriteResult(result)
      setDispatchOpen(false)
      setEmployee('')
      setTitle('')
      setBody('')
      // Reconcile after the write's rows are on screen; an immediate second read
      // can still observe the previous WAL snapshot and overwrite the result.
      if (result?.tasks === undefined) void load()
      else window.setTimeout(() => { void load() }, 2000)
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
    try {
      const result = await bridge.transitionTask({
        projectId: PROJECT_ID,
        taskId,
        status,
        ...(reasonText === undefined || reasonText.trim() === '' ? {} : { reason: reasonText.trim() }),
      })
      applyWriteResult(result)
      setReasonFor(null)
      setReason('')
      if (result?.tasks === undefined) void load()
      else window.setTimeout(() => { void load() }, 2000)
      setNotice({ tone: 'neutral', text: '状态已更新，列表已刷新' })
    } catch (error) {
      setNotice({ tone: 'danger', text: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  const onTransition = (taskId: string, status: TransitionStatus) => {
    if (status === 'verified') {
      void submitTransition(taskId, status)
      return
    }
    setReasonFor({ taskId, status })
    setReason('')
  }

  const offline = state.kind === 'fallback'
  const tasks = state.kind === 'ready'
    ? state.tasks
    : offline ? SAMPLE_TASKS : []

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h1 style={{ margin: 0, flex: 1 }}>协作</h1>
        {offline && <Tag tone="neutral">离线示例数据</Tag>}
        {!canDispatch && <Tag tone="neutral">写入通道待接入</Tag>}
        <Button
          variant="primary"
          size="sm"
          onClick={() => { setNotice(null); setDispatchOpen(true) }}
        >
          派活
        </Button>
      </div>
      <p style={{ margin: 0 }}>
        {state.kind === 'ready'
          ? `台账 · 项目 ${PROJECT_ID}`
          : `台账 · 项目 ${PROJECT_ID} · ${state.kind === 'fallback' ? state.reason : '读取中'}`}
      </p>

      {notice !== null && (
        <p role={notice.tone === 'danger' ? 'alert' : 'status'} style={{ margin: 0 }}>
          {notice.text}
        </p>
      )}

      {state.kind === 'loading' && (
        <div role="status" aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0' }}>
          <StateDot state="ongoing" />
          <span>读取台账…</span>
        </div>
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
            placeholder={roster.length > 0 ? '选择或输入员工 sessionId' : '输入员工 sessionId'}
            disabled={pending}
          />
          {roster.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {roster.map(member => (
                <Button
                  key={member.sessionId}
                  variant="outline"
                  size="sm"
                  onClick={() => { setEmployee(member.sessionId) }}
                >
                  {member.name ?? member.sessionId}
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
            style={{ resize: 'vertical', font: 'inherit', padding: '8px 10px' }}
          />
          {!canDispatch && <p style={{ margin: 0 }}>写入通道待接入，当前仅可预览表单。</p>}
        </div>
      </Modal>

      <Modal
        open={acceptFor !== null}
        onClose={() => { setAcceptFor(null) }}
        title="验收任务"
        description={acceptFor ?? undefined}
        closeLabel="关闭"
        footer={(
          <Button variant="outline" onClick={() => { setAcceptFor(null) }}>取消</Button>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <Button
            variant="primary"
            onClick={() => {
              const taskId = acceptFor
              setAcceptFor(null)
              if (taskId !== null) void submitTransition(taskId, 'verified')
            }}
          >
            通过验收
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const taskId = acceptFor
              setAcceptFor(null)
              if (taskId !== null) onTransition(taskId, 'rework')
            }}
          >
            退回重做
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const taskId = acceptFor
              setAcceptFor(null)
              if (taskId !== null) onTransition(taskId, 'failed')
            }}
          >
            标记失败
          </Button>
          {!canTransition && <p style={{ margin: 0 }}>写入通道待接入，当前仅可预览操作。</p>}
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
            style={{ resize: 'vertical', font: 'inherit', padding: '8px 10px' }}
          />
        </div>
      </Modal>
    </div>
  )
}
