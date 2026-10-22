/**
 * Cadre collaboration panel (milestone 1).
 *
 * Reads the desktop bridge `window.cadre.listTasks` when available and falls
 * back to labelled sample rows otherwise, so the panel stays usable before the
 * main-process SQLite channel ships. Only shipped primitives and inline layout
 * are used; no custom palette or stylesheet.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, IconBranchOutlineRegular, Pill, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** One ledger row as delivered by the desktop bridge. */
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

declare global {
  interface Window {
    cadre?: {
      listTasks(query: { projectId: string }): Promise<{
        projectId: string
        rows: CadreTaskRow[]
        elapsedMs?: number
      }>
    }
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

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly tasks: readonly CadreTask[] }
  | { readonly kind: 'fallback'; readonly reason: string }

/** Decorative sidebar glyph for the Cadre panel row. */
export function CadreIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}

/** Display labels for the ledger's status codes. */
const STATUS_LABELS: Record<string, string> = {
  delivered: '已交付',
  in_progress: '进行中',
  verified: '已验收',
  failed: '失败',
  cancelled: '已取消',
}

function TaskRow({ task }: { readonly task: CadreTask }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
      <Tag tone="neutral">{task.taskId}</Tag>
      <span style={{ flex: 1 }}>{task.title}</span>
      <span>{task.assignee}</span>
      <Pill>{STATUS_LABELS[task.status] ?? task.status}</Pill>
    </li>
  )
}

/** Static ledger surface; main-panel props are not used at milestone 1. */
export function CadrePanel(_props: PropsRuntime<'main'>) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })

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
      setState({ kind: 'fallback', reason: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const offline = state.kind === 'fallback'
  const tasks = state.kind === 'ready'
    ? state.tasks
    : offline ? SAMPLE_TASKS : []

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h1 style={{ margin: 0, flex: 1 }}>协作</h1>
        {offline && <Tag tone="neutral">离线示例数据</Tag>}
      </div>
      <p style={{ margin: 0 }}>
        {state.kind === 'ready'
          ? `台账 · 项目 ${PROJECT_ID}`
          : `台账 · 项目 ${PROJECT_ID} · ${state.kind === 'fallback' ? state.reason : '读取中'}`}
      </p>

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
            {tasks.map(task => <TaskRow key={task.taskId} task={task} />)}
          </ul>
          {offline && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>以上为离线示例数据，不代表真实台账。</span>
              <Button variant="outline" size="sm" onClick={() => { void load() }}>重试</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
