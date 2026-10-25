// @vitest-environment jsdom
/** W3 report fold: one compact line by default, expandable, state survives remount. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CadreReportNodeView } from '../src/client/chat/CadreReportCard.tsx'

const CONTENT = [
  '【员工汇报】',
  '任务号：task-fff2',
  '标题：实现汇报折叠行',
  '回报人：s-worker',
  '',
  '已完成折叠行实现，提交 0c78a142（2 files, 16+/3-）。',
  '详情：折叠态只占一行，展开后可读全文。',
  '',
  '交付物：src/client/a.ts, src/client/b.ts',
  '任务已置 delivered，可用 transition_task 验收（verified / rework）。',
].join('\n')

function reportFor(taskId: string): string {
  return CONTENT.replaceAll('task-fff2', taskId)
}

beforeEach(() => {
  window.localStorage.clear()
  ;(window as unknown as { cadre?: unknown }).cadre = {
    listTasks: vi.fn(async () => ({
      rows: [{ taskId: 'task-fff2', title: '实现汇报折叠行', status: 'delivered' }],
    })),
    transitionTask: vi.fn(async () => ({ ok: true, ledgerUpdated: true })),
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { cadre?: unknown }).cadre
  window.localStorage.clear()
})

describe('CadreReportNodeView', () => {
  it('renders one compact line by default, hiding the full body and actions', () => {
    render(<CadreReportNodeView content={CONTENT} projectId="ws-1" sessionId="s-supervisor" />)
    expect(screen.getByText('员工汇报')).toBeTruthy()
    expect(screen.getByText('task-fff2')).toBeTruthy()
    expect(screen.getByText(/已完成折叠行实现/)).toBeTruthy()
    expect(screen.queryByText(/详情：折叠态只占一行/)).toBeNull()
    expect(screen.queryByRole('button', { name: '打回重做' })).toBeNull()
    expect(screen.getByRole('button', { name: '展开' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('expands to the full report with deliverables and acceptance actions, then collapses', async () => {
    render(<CadreReportNodeView content={CONTENT} projectId="ws-1" sessionId="s-supervisor" />)
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    expect(screen.getByText(/详情：折叠态只占一行/)).toBeTruthy()
    expect(screen.getByText('src/client/a.ts')).toBeTruthy()
    expect(screen.getByText('src/client/b.ts')).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('待主管审')).toBeTruthy() })
    expect(screen.getByRole('button', { name: '打回重做' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText(/详情：折叠态只占一行/)).toBeNull()
  })

  it('remembers an expanded report across a remount', () => {
    const first = render(<CadreReportNodeView content={CONTENT} projectId="ws-1" sessionId="s-supervisor" />)
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    first.unmount()
    render(<CadreReportNodeView content={CONTENT} projectId="ws-1" sessionId="s-supervisor" />)
    expect(screen.getByText(/详情：折叠态只占一行/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
  })

  it('keeps three reports as three compact rows', () => {
    render(
      <>
        <CadreReportNodeView content={reportFor('task-1')} projectId="ws-1" sessionId="s-supervisor" />
        <CadreReportNodeView content={reportFor('task-2')} projectId="ws-1" sessionId="s-supervisor" />
        <CadreReportNodeView content={reportFor('task-3')} projectId="ws-1" sessionId="s-supervisor" />
      </>,
    )
    expect(screen.getAllByRole('button', { name: '展开' })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '打回重做' })).toBeNull()
    expect(screen.queryByText(/详情：折叠态只占一行/)).toBeNull()
  })
})
