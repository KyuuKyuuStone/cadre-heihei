/**
 * Cadre collaboration panel (milestone 1).
 *
 * A static ledger rendered with the shipped primitives only: no custom CSS or
 * palette. Rows will be replaced by the read-only SQLite ledger once the main
 * process exposes it.
 */
import { IconBranchOutlineRegular, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const ROWS = [
  { taskId: 'task-101', title: '补齐 M3 验收矩阵', status: '已验收', assignee: '前端' },
  { taskId: 'task-102', title: '事件泵补发适配', status: '验收中', assignee: '前端' },
  { taskId: 'task-103', title: '默认中文与偏好回退', status: '已交付', assignee: '前端' },
  { taskId: 'task-104', title: '官方壳协作面板挂出', status: '进行中', assignee: '前端' },
] as const

/** Decorative sidebar glyph for the Cadre panel row. */
export function CadreIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}

/** Static ledger surface; main-panel props are not used at milestone 1. */
export function CadrePanel(_props: PropsRuntime<'main'>) {
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <h1 style={{ margin: 0 }}>协作</h1>
      <p style={{ margin: 0 }}>台账（静态）· 项目=公司，会话=员工</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ROWS.map(row => (
          <li key={row.taskId} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
            <Tag tone="neutral">{row.taskId}</Tag>
            <span style={{ flex: 1 }}>{row.title}</span>
            <span>{row.assignee}</span>
            <Pill>{row.status}</Pill>
          </li>
        ))}
      </ul>
    </div>
  )
}
