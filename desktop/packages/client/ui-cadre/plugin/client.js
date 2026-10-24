/**
 * Cadre collaboration surface (spike).
 *
 * Registers one sidebar panellist row ("协作") and the main panel keyed by the
 * same id. Renders a static ledger sample using only ui-primitives components;
 * no custom CSS or palette is introduced.
 */
import { jsx, jsxs } from 'react/jsx-runtime'
import {
  IconBranchOutlineRegular,
  Pill,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

const PANEL_ID = 'cadre'

const STATIC_ROWS = [
  { id: 'task-101', title: '补齐 M3 验收矩阵', assignee: '前端员工', status: '已验收' },
  { id: 'task-102', title: '事件泵补发适配', assignee: '前端员工', status: '验收中' },
  { id: 'task-103', title: '默认中文与偏好回退', assignee: '前端员工', status: '已交付' },
  { id: 'task-104', title: '插件机制 spike', assignee: '前端员工', status: '进行中' },
]

function CadreIcon({ size }) {
  return jsx(IconBranchOutlineRegular, { size })
}

function CadrePage() {
  return jsxs('div', {
    style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
    children: [
      jsx('h1', { style: { margin: 0 }, children: '协作' }),
      jsx('p', { style: { margin: 0 }, children: '项目=公司 · 会话=员工 · 静态台账（spike）' }),
      jsx('ul', {
        style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
        children: STATIC_ROWS.map((row) => jsxs('li', {
          style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' },
          children: [
            jsx(Tag, { tone: 'neutral', children: row.id }),
            jsx('span', { style: { flex: 1 }, children: row.title }),
            jsx('span', { children: row.assignee }),
            jsx(Pill, { children: row.status }),
          ],
        }, row.id)),
      }),
    ],
  })
}

export const name = 'ui-cadre'

/** Slot service is the only host capability this spike needs. */
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => '协作',
  }, CadreIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, CadrePage))
}
