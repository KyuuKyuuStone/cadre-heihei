// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  CadreProjectRowActions, CadreRetireDialog, CadreRetireMenuItem,
  CadreSessionBadge, CadreSessionSubtitle,
  type CadreRosterState,
} from '../src/client/CadreSidebar.tsx'
import { CadreCreateDialog } from '../src/client/CadreCreateDialog.tsx'
import type { CadreStallState } from '../src/client/cadre-stall.ts'
import { zh, type SidebarKey } from '../src/client/locales.ts'
import type { CadreProjectState } from '../src/client/contract/slots.ts'

const EMPTY_STALL: CadreStallState = { byProject: new Map(), bySession: new Map() }
const emptyStallHook = ((selector: (value: CadreStallState) => unknown) => selector(EMPTY_STALL)) as never
const t = ((key: SidebarKey, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}) as never

afterEach(cleanup)

type Props = ComponentProps<typeof CadreProjectRowActions>

function projectState(supervisors: readonly string[] = []): CadreProjectState {
  return { supervisors: new Set(supervisors), defaultProjectId: 'ws-1' }
}

function rosterState(
  status: 'loading' | 'ready' | 'error',
  memberCount = 0,
  error?: string,
): CadreRosterState {
  return {
    status: 'ready',
    members: [],
    error: null,
    projects: new Map([['ws-1', {
      status,
      memberCount,
      ...(error === undefined ? {} : { error }),
    }]]),
  }
}

function mount(overrides: {
  supervisors?: readonly string[]
  cwd?: string | undefined
  roster?: CadreRosterState
} = {}) {
  const startSession = vi.fn()
  const requestCadreCreate = vi.fn()
  const openLedger = vi.fn()
  const retryRoster = vi.fn()
  const state = projectState(overrides.supervisors)
  const roster = overrides.roster ?? rosterState('ready', 1)
  const props: Props = {
    workspaceId: 'ws-1',
    label: '项目部 A',
    ...(overrides.cwd === undefined && 'cwd' in overrides ? {} : { cwd: overrides.cwd ?? '/tmp/a' }),
    useProjectState: ((selector: (value: CadreProjectState) => unknown) => selector(state)) as never,
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never,
    retryRoster,
    startSession,
    requestCadreCreate,
    openLedger,
  }
  render(<CadreProjectRowActions {...props} />)
  return { startSession, requestCadreCreate, openLedger, retryRoster }
}

describe('CadreProjectRowActions', () => {
  it('renders the ＋ and 台账 affordances on a project row', () => {
    mount()
    expect(screen.getByRole('button', { name: '在“项目部 A”中新建' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看“项目部 A”台账' })).toBeTruthy()
    expect(screen.getByText('台账')).toBeTruthy()
  })

  it('offers supervisor / employee / plain session and routes each choice', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: '在“项目部 A”中新建' }))
    expect(screen.getByRole('menuitem', { name: '主管' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '员工' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '普通会话' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: '员工' }))
    expect(b.requestCadreCreate).toHaveBeenCalledExactlyOnceWith('worker', 'ws-1')
    expect(b.startSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '在“项目部 A”中新建' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '主管' }))
    expect(b.requestCadreCreate).toHaveBeenLastCalledWith('supervisor', 'ws-1')

    fireEvent.click(screen.getByRole('button', { name: '在“项目部 A”中新建' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '普通会话' }))
    expect(b.startSession).toHaveBeenCalledExactlyOnceWith('ws-1')
    expect(b.requestCadreCreate).toHaveBeenCalledTimes(2)
  })

  it('greys the supervisor item when this project already has one', () => {
    const b = mount({ supervisors: ['ws-1'] })
    fireEvent.click(screen.getByRole('button', { name: '在“项目部 A”中新建' }))
    const supervisor = screen.getByRole('menuitem', { name: '主管（已有）' })
    expect(supervisor.hasAttribute('disabled')).toBe(true)
    fireEvent.click(supervisor)
    expect(b.requestCadreCreate).not.toHaveBeenCalled()
  })

  it('keeps another project supervisor from disabling this row', () => {
    mount({ supervisors: ['ws-2'] })
    fireEvent.click(screen.getByRole('button', { name: '在“项目部 A”中新建' }))
    expect(screen.getByRole('menuitem', { name: '主管' }).hasAttribute('disabled')).toBe(false)
  })

  it('opens the ledger with the row Workspace id as projectId', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: '查看“项目部 A”台账' }))
    expect(b.openLedger).toHaveBeenCalledExactlyOnceWith({
      projectId: 'ws-1',
      label: '项目部 A',
      cwd: '/tmp/a',
    })
  })

  it('omits cwd when the Workspace has none', () => {
    const b = mount({ cwd: undefined })
    fireEvent.click(screen.getByRole('button', { name: '查看“项目部 A”台账' }))
    expect(b.openLedger).toHaveBeenCalledExactlyOnceWith({
      projectId: 'ws-1',
      label: '项目部 A',
    })
  })

  it('shows a project-level loading state separately from an empty team', () => {
    mount({ roster: rosterState('loading') })
    expect(screen.getByText('读取中')).toBeTruthy()
    expect(screen.queryByText('空团队')).toBeNull()
    cleanup()
    mount({ roster: rosterState('ready', 0) })
    expect(screen.getByText('空团队')).toBeTruthy()
    expect(screen.queryByText('读取中')).toBeNull()
  })

  it('shows a read failure with retry instead of an empty team', () => {
    const b = mount({ roster: rosterState('error', 0, '磁盘读取失败') })
    const retry = screen.getByRole('button', { name: /花名册读取失败，重试：磁盘读取失败/ })
    expect(screen.queryByText('空团队')).toBeNull()
    fireEvent.click(retry)
    expect(b.retryRoster).toHaveBeenCalledOnce()
  })

  it('keeps clicks inside the strip from toggling the project row', () => {
    const outer = vi.fn()
    const startSession = vi.fn()
    const requestCadreCreate = vi.fn()
    const openLedger = vi.fn()
    const retryRoster = vi.fn()
    const state = projectState()
    const roster = rosterState('ready', 1)
    render(
      <div onClick={outer}>
        <CadreProjectRowActions
          workspaceId="ws-1" label="项目部 A" cwd="/tmp/a"
          useProjectState={((selector: (value: CadreProjectState) => unknown) => selector(state)) as never}
          useRoster={((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never}
          retryRoster={retryRoster}
          startSession={startSession} requestCadreCreate={requestCadreCreate} openLedger={openLedger}
        />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: '查看“项目部 A”台账' }))
    expect(openLedger).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('supervisor create dialog', () => {
  it('prefills the role name and uses it as the placeholder', () => {
    render(<CadreCreateDialog {...({
      useCreateRequest: (selector: (value: unknown) => unknown) => selector({
        kind: 'supervisor', token: 1, workspaceId: 'ws-1', projectLabel: '项目部 A',
      }),
      closeCreate: vi.fn(),
      createRosterEntry: vi.fn(),
      refreshSupervisor: vi.fn(),
    } as unknown as ComponentProps<typeof CadreCreateDialog>)} />)
    const input = screen.getByLabelText('名字') as HTMLInputElement
    expect(input.value).toBe('主管')
    expect(input.placeholder).toBe('主管')
  })
})

describe('session identity', () => {
  const roster = (member: CadreRosterState['members'][number]): CadreRosterState => ({
    status: 'ready',
    members: [member],
    error: null,
  })

  it('marks the supervisor badge so the row title can be tinted', () => {
    const state = roster({ sessionId: 's1', role: 'supervisor' })
    render(<CadreSessionBadge {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
    } as unknown as ComponentProps<typeof CadreSessionBadge>)} />)
    expect(screen.getByText('主管').className.split(' ')).toContain('cadre-role-supervisor')
  })

  it('marks the employee badge with the worker role token and the position', () => {
    const state = roster({ sessionId: 's1', role: 'worker', description: '前端' })
    render(<CadreSessionBadge {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
    } as unknown as ComponentProps<typeof CadreSessionBadge>)} />)
    const badge = screen.getByText('员工 · 前端')
    expect(badge.className.split(' ')).toContain('cadre-role-worker')
    expect(badge.getAttribute('title')).toBe('岗位：前端')
  })

  it('keeps a departed employee distinct from an ordinary session', () => {
    const state = roster({ sessionId: 's1', role: 'worker', displayName: '前端', state: 'departed' })
    render(<CadreSessionBadge {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
    } as unknown as ComponentProps<typeof CadreSessionBadge>)} />)
    expect(screen.getByText('已离职')).toBeTruthy()
    cleanup()
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
      useStall: emptyStallHook,
      t,
    })} />)
    expect(screen.getByText('历史归属')).toBeTruthy()
    expect(screen.queryByText('普通会话')).toBeNull()
  })

  it('keeps a true non-member as an ordinary session', () => {
    const state: CadreRosterState = { status: 'ready', members: [], error: null }
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
      useStall: emptyStallHook,
      t,
    })} />)
    expect(screen.getByText('普通会话')).toBeTruthy()
    expect(screen.queryByText('历史归属')).toBeNull()
  })

  it('shows only live activity on the subtitle, not the repeated position', () => {
    const state = roster({ sessionId: 's1', role: 'worker', description: '前端' })
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
      useStall: emptyStallHook,
      t,
    })} />)
    expect(screen.getByText('空闲')).toBeTruthy()
    expect(screen.queryByText('前端')).toBeNull()
  })

  it('appends the host stall state and last activity without changing the base status', () => {
    const state = roster({ sessionId: 's1', role: 'worker', description: '前端' })
    const stall: CadreStallState = {
      byProject: new Map(),
      bySession: new Map([['s1', {
        worstState: 'stalled',
        stalledCount: 1,
        possiblyStalledCount: 0,
        lastActivityAt: Date.now() - 5 * 60_000,
        episodeIds: ['task-1:episode'],
      }]]),
    }
    const useStall = ((selector: (value: CadreStallState) => unknown) => selector(stall)) as never
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
      useStall,
      t,
    })} />)
    expect(screen.getByText(/空闲 · 已停摆 · 5 分钟前/)).toBeTruthy()
  })

  it('shows a lost-roster warning instead of claiming an ordinary session', () => {
    const state: CadreRosterState = {
      status: 'ready',
      members: [],
      error: null,
      notice: '团队数据丢失或未找到：花名册为空。',
    }
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
      useStall: emptyStallHook,
      t,
    })} />)
    expect(screen.getByText('团队数据丢失').getAttribute('title')).toContain('花名册为空')
    expect(screen.queryByText('普通会话')).toBeNull()
  })
})

describe('member retirement', () => {
  const roster: CadreRosterState = {
    status: 'ready',
    members: [{ sessionId: 's1', role: 'worker', displayName: '前端', state: 'available' }],
    error: null,
  }
  const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never
  const supervisorRoster: CadreRosterState = {
    status: 'ready',
    members: [{ sessionId: 's1', role: 'supervisor', displayName: '主管', state: 'available' }],
    error: null,
  }
  const useSupervisorRoster = ((selector: (value: CadreRosterState) => unknown) =>
    selector(supervisorRoster)) as never

  it('raises a request from the row menu instead of rendering its dialog there', () => {
    const setMenuOpen = vi.fn()
    const requestRetire = vi.fn()
    render(
      <CadreRetireMenuItem
        sessionId="s1" displayTitle="前端"
        useMenuOpenState={() => [true, setMenuOpen]}
        useRoster={useRoster}
        useRequest={((selector: (value: null) => unknown) => selector(null)) as never}
        requestRetire={requestRetire} settleRetire={vi.fn()} retire={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '离职…' }))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(requestRetire).toHaveBeenCalledWith('s1', '前端')
    expect(screen.queryByText('确认离职')).toBeNull()
  })

  it('confirms through the retire hop and settles the request', async () => {
    const retire = vi.fn(async () => ({ ok: true }))
    const settleRetire = vi.fn()
    render(
      <CadreRetireDialog
        useRoster={useRoster}
        useRequest={((selector: (value: unknown) => unknown) => selector(
          { sessionId: 's1', displayTitle: '前端', token: 1 },
        )) as never}
        requestRetire={vi.fn()} settleRetire={settleRetire} retire={retire}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    await waitFor(() => { expect(retire).toHaveBeenCalledWith('s1') })
    await waitFor(() => { expect(settleRetire).toHaveBeenCalledOnce() })
  })

  const OPEN_TASKS = [{
    taskId: 'task-1', title: '未结任务', status: 'in_progress', updatedAt: '2026-10-28T10:00:00+08:00',
  }]

  function renderRetire(
    retire: ComponentProps<typeof CadreRetireDialog>['retire'],
    settleRetire = vi.fn(),
    rosterHook: ComponentProps<typeof CadreRetireDialog>['useRoster'] = useRoster,
  ) {
    render(
      <CadreRetireDialog
        useRoster={rosterHook}
        useRequest={((selector: (value: unknown) => unknown) => selector(
          { sessionId: 's1', displayTitle: '前端', token: 3 },
        )) as never}
        requestRetire={vi.fn()} settleRetire={settleRetire} retire={retire}
      />,
    )
    return settleRetire
  }

  it('shows open tasks and keeps confirm disabled until a disposition is selected', async () => {
    const retire = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'OPEN_TASKS', message: '有未结任务', tasks: OPEN_TASKS })
      .mockResolvedValueOnce({ ok: true })
    renderRetire(retire)
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    expect(await screen.findByText('未结任务')).toBeTruthy()
    expect(screen.getByText('task-1')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: '确认离职' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole('radio', { name: '取消任务' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '转回主管' })).toBeTruthy()
    const transfer = screen.getByRole('radio', { name: '转给其他员工（0.10.0 支持）' }) as HTMLButtonElement
    expect(transfer.disabled).toBe(true)
    expect(screen.getByText(/0\.10\.0 支持/)).toBeTruthy()
  })

  it('sends cancel disposition after a selected open task', async () => {
    const retire = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'OPEN_TASKS', message: '有未结任务', tasks: OPEN_TASKS })
      .mockResolvedValueOnce({ ok: true })
    const settleRetire = renderRetire(retire)
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    fireEvent.click(await screen.findByRole('radio', { name: '取消任务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    await waitFor(() => { expect(retire).toHaveBeenNthCalledWith(2, 's1', { taskDisposition: 'cancel' }) })
    await waitFor(() => { expect(settleRetire).toHaveBeenCalledOnce() })
  })

  it('sends return disposition after a selected open task', async () => {
    const retire = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'OPEN_TASKS', message: '有未结任务', tasks: OPEN_TASKS })
      .mockResolvedValueOnce({ ok: true })
    const settleRetire = renderRetire(retire)
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    fireEvent.click(await screen.findByRole('radio', { name: '转回主管' }))
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    await waitFor(() => { expect(retire).toHaveBeenNthCalledWith(2, 's1', { taskDisposition: 'return' }) })
    await waitFor(() => { expect(settleRetire).toHaveBeenCalledOnce() })
  })

  it('offers only cancel to a supervisor with open tasks and explains why return is unavailable', async () => {
    const retire = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'OPEN_TASKS', message: '有未结任务', tasks: OPEN_TASKS })
      .mockResolvedValueOnce({ ok: true })
    const settleRetire = renderRetire(retire, vi.fn(), useSupervisorRoster)
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    expect(await screen.findByText('未结任务')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '取消任务' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: '转回主管' })).toBeNull()
    expect(screen.getByText(/主管离职后无其他接手人/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: '转给其他员工（0.10.0 支持）' }).hasAttribute('disabled')).toBe(true)
    const confirm = screen.getByRole('button', { name: '确认离职' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '取消任务' }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(retire).toHaveBeenNthCalledWith(2, 's1', { taskDisposition: 'cancel' }) })
    await waitFor(() => { expect(settleRetire).toHaveBeenCalledOnce() })
  })

  it('shows the backend refusal instead of closing on a failed retire', async () => {
    const retire = vi.fn(async () => ({ ok: false, code: 'NOT_FOUND', message: '不在花名册' }))
    const settleRetire = vi.fn()
    render(
      <CadreRetireDialog
        useRoster={useRoster}
        useRequest={((selector: (value: unknown) => unknown) => selector(
          { sessionId: 's1', displayTitle: '前端', token: 2 },
        )) as never}
        requestRetire={vi.fn()} settleRetire={settleRetire} retire={retire}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认离职' }))
    expect((await screen.findByRole('alert')).textContent).toContain('NOT_FOUND · 不在花名册')
    expect(settleRetire).not.toHaveBeenCalled()
  })
})
