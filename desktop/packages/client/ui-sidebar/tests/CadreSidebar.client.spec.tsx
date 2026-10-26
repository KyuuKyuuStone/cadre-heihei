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
import type { CadreProjectState } from '../src/client/contract/slots.ts'

afterEach(cleanup)

type Props = ComponentProps<typeof CadreProjectRowActions>

function projectState(supervisors: readonly string[] = []): CadreProjectState {
  return { supervisors: new Set(supervisors), defaultProjectId: 'ws-1' }
}

function mount(overrides: {
  supervisors?: readonly string[]
  cwd?: string | undefined
} = {}) {
  const startSession = vi.fn()
  const requestCadreCreate = vi.fn()
  const openLedger = vi.fn()
  const state = projectState(overrides.supervisors)
  const props: Props = {
    workspaceId: 'ws-1',
    label: '项目部 A',
    ...(overrides.cwd === undefined && 'cwd' in overrides ? {} : { cwd: overrides.cwd ?? '/tmp/a' }),
    useProjectState: ((selector: (value: CadreProjectState) => unknown) => selector(state)) as never,
    startSession,
    requestCadreCreate,
    openLedger,
  }
  render(<CadreProjectRowActions {...props} />)
  return { startSession, requestCadreCreate, openLedger }
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

  it('keeps clicks inside the strip from toggling the project row', () => {
    const outer = vi.fn()
    const startSession = vi.fn()
    const requestCadreCreate = vi.fn()
    const openLedger = vi.fn()
    const state = projectState()
    render(
      <div onClick={outer}>
        <CadreProjectRowActions
          workspaceId="ws-1" label="项目部 A" cwd="/tmp/a"
          useProjectState={((selector: (value: CadreProjectState) => unknown) => selector(state)) as never}
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

  it('shows only live activity on the subtitle, not the repeated position', () => {
    const state = roster({ sessionId: 's1', role: 'worker', description: '前端' })
    render(<CadreSessionSubtitle {...({
      sessionId: 's1',
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(state)) as never,
      useSessions: ((selector: (value: { byId: Record<string, { running?: boolean }> }) => unknown) =>
        selector({ byId: {} })) as never,
      useTasks: ((selector: (value: readonly unknown[]) => unknown) => selector([])) as never,
    } as unknown as ComponentProps<typeof CadreSessionSubtitle>)} />)
    expect(screen.getByText('空闲')).toBeTruthy()
    expect(screen.queryByText('前端')).toBeNull()
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
    } as unknown as ComponentProps<typeof CadreSessionSubtitle>)} />)
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
