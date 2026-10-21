/**
 * M3 验收证据 · 三屏 × 八态矩阵 + 权限可见性（任务 38e917dd）。
 *
 * 每格用 fake CadreApi 驱动到目标态，断言 DOM data-state 与视觉语义：
 * - empty 必带 reason/hint，不用 error 样式、不设 role=alert（empty≠error，铁律 11）；
 * - error 设 role=alert；denied 与 error 可区分（state--denied ≠ state--error）；
 * - streaming 有进行中标识（role=status）。
 *
 * 适用范围（与 frontend/01 §2 状态矩阵对齐，矩阵全表见 docs/product/testing/03-M3验收矩阵.md）：
 * - idle 屏级 N/A（需求无 idle 场景；组件级 idle 由 state-boundary.test 覆盖）；
 * - truncated 屏级未接线（StateBoundary/viewState 支持已单测，屏级无驱动路径）——矩阵记未通过格；
 * - ledger/roster 的 streaming、roster 的 truncated 为需求外 N/A。
 * 本文件只包含可断言格子；未通过/N-A 格子由矩阵文档与 evidence JSON 记录。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '../../../src/shared/ipc.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { IdentityProvider } from '../../../src/renderer/data/IdentityProvider.tsx'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { ConversationScreen } from '../../../src/renderer/screens/conversation/ConversationScreen.tsx'
import { LedgerScreen } from '../../../src/renderer/screens/ledger/LedgerScreen.tsx'
import { RosterScreen } from '../../../src/renderer/screens/roster/RosterScreen.tsx'
import { createFakeCadreApi, fakeFailure, fakeIds, fakeTask, fakeTaskDetail } from '../data/fake-api.ts'
import { StateBoundary } from '../../../src/renderer/components/StateBoundary.tsx'
import type { ViewState } from '../../../src/renderer/components/viewState.ts'

describe('M3 矩阵 · StateBoundary 组件级八态（data-state/role 语义）', () => {
  it('八态全部产出正确 data-state 与 role：idle/loading=progress(status)、streaming 内嵌、truncated 标注、denied/alert', () => {
    const cases: Array<{ state: ViewState<null>; dataState: string; role: string | null }> = [
      { state: { status: 'idle' }, dataState: 'idle', role: 'status' },
      { state: { status: 'loading' }, dataState: 'loading', role: 'status' },
      { state: { status: 'empty', reason: 'r', hint: 'h' }, dataState: 'empty', role: 'status' },
      { state: { status: 'error', message: 'm' }, dataState: 'error', role: 'alert' },
      { state: { status: 'denied', message: 'd' }, dataState: 'denied', role: 'alert' },
    ]
    for (const c of cases) {
      const { container, unmount } = render(
        <LocaleProvider initialLocale="zh"><StateBoundary state={c.state} renderReady={() => null} /></LocaleProvider>,
      )
      const el = container.querySelector(`[data-state="${c.dataState}"]`)
      expect(el, `data-state=${c.dataState}`).not.toBeNull()
      expect(el?.getAttribute('role')).toBe(c.role)
      unmount()
    }
    // truncated：内容 + 截断标注（state-truncated，role=status）
    const t = render(
      <LocaleProvider initialLocale="zh">
        <StateBoundary
          state={{ status: 'truncated', data: null, truncated: { totalLines: 88, shownLines: 10 } }}
          renderReady={() => <p>内容</p>}
        />
      </LocaleProvider>,
    )
    expect(t.container.querySelector('[data-state="truncated"]')).not.toBeNull()
    expect(t.container.querySelector('.state-truncated')?.getAttribute('role')).toBe('status')
    expect(t.container.textContent).toContain('88')
    t.unmount()
    // streaming：ready 内容 + 内嵌进行中标识
    const s = render(
      <LocaleProvider initialLocale="zh">
        <StateBoundary state={{ status: 'streaming', data: null }} renderReady={() => <p>流内容</p>} />
      </LocaleProvider>,
    )
    expect(s.container.querySelector('[data-state="streaming"]')).not.toBeNull()
    expect(s.container.querySelector('[role="status"]')).not.toBeNull()
    s.unmount()
  })
})

function withProviders(api: CadreApi, ui: React.ReactNode) {
  return render(
    <CadreApiProvider api={api}>
      <IdentityProvider>
        <LocaleProvider initialLocale="zh">
          {ui}
        </LocaleProvider>
      </IdentityProvider>
    </CadreApiProvider>,
  )
}

const pending = <T,>(): Promise<T> => new Promise(() => {})

function dataState(container: HTMLElement, state: string): Element | null {
  return container.querySelector(`[data-state="${state}"]`)
}

// ── 会话流（ConversationScreen）──

describe('M3 矩阵 · 会话流', () => {
  it('empty：reason/hint 齐全，无 error 样式、无 role=alert', () => {
    const { container } = withProviders(createFakeCadreApi(), <ConversationScreen />)
    const empty = dataState(container, 'empty')
    expect(empty).not.toBeNull()
    expect(empty?.className).toContain('state--empty')
    expect(empty?.className).not.toContain('state--error')
    expect(empty?.getAttribute('role')).toBe('status')
    expect(empty?.querySelector('.state__reason')?.textContent?.length ?? 0).toBeGreaterThan(0)
    expect(empty?.querySelector('.state__hint')?.textContent?.length ?? 0).toBeGreaterThan(0)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('error：session.error 事件 → role=alert + data-state=error（订阅失败为静默重试路径，error 由事件流驱动）', async () => {
    let listener: ((event: SessionEvent) => void) | undefined
    const api = createFakeCadreApi({
      subscribeSession: vi.fn(async () => ({ ok: true as const, subscriptionId: 'sub-1' })),
      onSessionEvent: vi.fn((cb: (event: SessionEvent) => void) => {
        listener = cb
        return () => {}
      }),
    })
    const { container } = withProviders(api, <ConversationScreen />)
    await waitFor(() => expect(listener).toBeDefined())
    act(() => listener?.({
      kind: 'session.error',
      sessionId: fakeIds.sessionId,
      error: { code: 'ENGINE_TIMEOUT', message: '会话服务超时', retryable: true },
      seq: 3,
      epoch: 1,
    }))
    await waitFor(() => expect(dataState(container, 'error')).not.toBeNull())
    const errorEl = dataState(container, 'error')
    expect(errorEl?.getAttribute('role')).toBe('alert')
    expect(errorEl?.className).toContain('state--error')
  })

  it('denied：发送遇 CROSS_PROJECT_DENIED → denied 呈现（与 error 样式可区分）', async () => {
    const receipt = {
      ok: true as const,
      bodyBytes: 9,
      preview: '第一条',
      bodySha256: 'a'.repeat(64),
      messageId: 'message-1',
      acceptedAt: '2026-10-21T10:00:00.000Z',
    }
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝'))
    const { container } = withProviders(createFakeCadreApi({ sendMessage }), <ConversationScreen />)
    const input = (await screen.findByTestId('composer-input')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: '第一条' } })
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(await screen.findByText('第一条')).toBeTruthy() // 等首次投递完成，避免 sending 期按钮禁用吞掉第二次点击
    fireEvent.change(input, { target: { value: '第二条' } })
    fireEvent.click(screen.getByTestId('composer-send'))
    const denied = await screen.findByTestId('conversation-denied')
    // 屏级手写 denied 块（非 StateBoundary）：类语义与 error 可区分，role=alert；无 data-state 属性（矩阵如实注记）。
    expect(denied.className).toContain('state--denied')
    expect(denied.className).not.toContain('state--error')
    expect(denied.getAttribute('role')).toBe('alert')
    expect(dataState(container, 'denied')).toBeNull()
  })

  it('streaming：增量 delta 事件 → 进行中标识（role=status）', async () => {
    let listener: ((event: SessionEvent) => void) | undefined
    const api = createFakeCadreApi({
      subscribeSession: vi.fn(async () => ({ ok: true as const, subscriptionId: 'sub-1' })),
      onSessionEvent: vi.fn((cb: (event: SessionEvent) => void) => {
        listener = cb
        return () => {}
      }),
    })
    const { container } = withProviders(api, <ConversationScreen />)
    await waitFor(() => expect(listener).toBeDefined())
    act(() => listener?.({ kind: 'message.delta', sessionId: fakeIds.sessionId, text: '流式增量', seq: 1, epoch: 1 }))
    const streaming = await screen.findByTestId('conversation-streaming')
    expect(streaming.getAttribute('role')).toBe('status')
    expect(dataState(container, 'ready')).not.toBeNull()
  })

  it('ready：complete 事件收敛 → data-state=ready 且流式标识消失', async () => {
    let listener: ((event: SessionEvent) => void) | undefined
    const api = createFakeCadreApi({
      subscribeSession: vi.fn(async () => ({ ok: true as const, subscriptionId: 'sub-1' })),
      onSessionEvent: vi.fn((cb: (event: SessionEvent) => void) => {
        listener = cb
        return () => {}
      }),
    })
    const { container } = withProviders(api, <ConversationScreen />)
    await waitFor(() => expect(listener).toBeDefined())
    act(() => listener?.({ kind: 'message.complete', sessionId: fakeIds.sessionId, text: '完整回答', seq: 2, epoch: 1 }))
    expect(await screen.findByText('完整回答')).toBeTruthy()
    expect(dataState(container, 'ready')).not.toBeNull()
    expect(screen.queryByTestId('conversation-streaming')).toBeNull()
  })
})

// ── 任务台账（LedgerScreen）──

describe('M3 矩阵 · 任务台账', () => {
  it('loading：listTasks 挂起 → data-state=loading（role=status，非 alert）', () => {
    const { container } = withProviders(createFakeCadreApi({ listTasks: () => pending() }), <LedgerScreen />)
    const loading = dataState(container, 'loading')
    expect(loading).not.toBeNull()
    expect(loading?.getAttribute('role')).toBe('status')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('ready：items 到达 → data-state=ready', async () => {
    const { container } = withProviders(
      createFakeCadreApi({ listTasks: async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [fakeTask()] }) }),
      <LedgerScreen />,
    )
    await screen.findByText('实现台账列表')
    expect(dataState(container, 'ready')).not.toBeNull()
  })

  it('empty：items=[] + reason/hint，无 alert、无 error 样式', async () => {
    const listTasks = async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      items: [],
      empty: true as const,
      reason: 'no_tasks' as const,
      hint: '前往会话流派发任务。',
    })
    const { container } = withProviders(createFakeCadreApi({ listTasks }), <LedgerScreen />)
    expect((await screen.findAllByText('还没有任务')).length).toBeGreaterThan(0)
    expect(screen.getByText('前往会话流派发任务。')).toBeTruthy()
    const empty = dataState(container, 'empty')
    expect(empty).not.toBeNull()
    expect(empty?.className).not.toContain('state--error')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('error：拉取失败 → role=alert + data-state=error', async () => {
    const { container } = withProviders(
      createFakeCadreApi({ listTasks: async () => fakeFailure('INTERNAL_ERROR', '服务错误') }),
      <LedgerScreen />,
    )
    await waitFor(() => expect(dataState(container, 'error')).not.toBeNull())
    expect(dataState(container, 'error')?.getAttribute('role')).toBe('alert')
  })

  it('denied：CROSS_PROJECT_DENIED → data-state=denied（不与 error 混淆）', async () => {
    const { container } = withProviders(
      createFakeCadreApi({ listTasks: async () => fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝') }),
      <LedgerScreen />,
    )
    expect(await screen.findByText('当前项目不可用')).toBeTruthy()
    const denied = dataState(container, 'denied')
    expect(denied).not.toBeNull()
    expect(denied?.className).toContain('state--denied')
    expect(denied?.className).not.toContain('state--error')
  })
})

// ── 花名册（RosterScreen）──

describe('M3 矩阵 · 花名册', () => {
  it('loading：listRoster 挂起 → data-state=loading', () => {
    const { container } = withProviders(createFakeCadreApi({ listRoster: () => pending() }), <RosterScreen />)
    expect(dataState(container, 'loading')).not.toBeNull()
  })

  it('ready：成员到达 → data-state=ready', async () => {
    const listRoster = async () => ({
      ok: true as const,
      apiVersion: 'cadre-heihei/1' as const,
      projects: [{ projectId: fakeIds.projectId, name: 'demo' }],
      members: [{
        sessionId: fakeIds.sessionId,
        displayName: '前端员工',
        role: 'worker' as const,
        state: 'available' as const,
        projectId: fakeIds.projectId,
        dispatchable: true,
      }],
      scope: {
        scope: { kind: 'project' as const, projectId: fakeIds.projectId },
        globalCount: 1,
        dispatchableCount: 1,
        projectMatched: true,
      },
    })
    const { container } = withProviders(createFakeCadreApi({ listRoster }), <RosterScreen />)
    await screen.findByText('前端员工')
    expect(dataState(container, 'ready')).not.toBeNull()
  })

  it('empty：默认空花名册 → data-state=empty + reason（scope 透传，双口径提示）', async () => {
    const { container } = withProviders(createFakeCadreApi(), <RosterScreen />)
    await screen.findByText('添加员工或切换项目。') // fake scope.hint 透传
    const emptyEl = dataState(container, 'empty')
    expect(emptyEl).not.toBeNull()
    expect(emptyEl?.className).not.toContain('state--error')
    expect(emptyEl?.querySelector('.state__reason')?.textContent?.length ?? 0).toBeGreaterThan(0)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('error：拉取失败 → role=alert', async () => {
    const { container } = withProviders(
      createFakeCadreApi({ listRoster: async () => fakeFailure('INTERNAL_ERROR', '花名册服务错误') }),
      <RosterScreen />,
    )
    await waitFor(() => expect(dataState(container, 'error')).not.toBeNull())
    expect(dataState(container, 'error')?.getAttribute('role')).toBe('alert')
  })

  it('denied：listRoster CROSS_PROJECT_DENIED → data-state=denied', async () => {
    const { container } = withProviders(
      createFakeCadreApi({ listRoster: async () => fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝') }),
      <RosterScreen />,
    )
    await waitFor(() => expect(dataState(container, 'denied')).not.toBeNull())
    expect(dataState(container, 'denied')?.className).toContain('state--denied')
  })
})

// ── 权限可见性（入口不渲染，而非仅禁用；IdentityProvider fake whoami 驱动）──

describe('M3 权限可见性', () => {
  it('worker：无派活入口（dispatch-panel 不渲染）', async () => {
    const api = createFakeCadreApi({
      whoami: async () => ({
        ok: true as const,
        apiVersion: 'cadre-heihei/1' as const,
        projectId: fakeIds.projectId,
        sessionId: fakeIds.sessionId,
        role: 'worker' as const,
        projectName: 'demo',
      }),
      listTasks: async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [fakeTask()] }),
      getTask: async () => ({ ok: true as const, ...fakeTaskDetail() }),
    })
    withProviders(api, <LedgerScreen />)
    await screen.findByText('实现台账列表')
    await waitFor(() => expect(screen.queryByTestId('dispatch-panel')).toBeNull())
  })

  it('非 assignee：无汇报入口（report-section 不渲染）', async () => {
    const api = createFakeCadreApi({
      whoami: async () => ({
        ok: true as const,
        apiVersion: 'cadre-heihei/1' as const,
        projectId: fakeIds.projectId,
        sessionId: 'session-other' as never,
        role: 'worker' as const,
        projectName: 'demo',
      }),
      listTasks: async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [fakeTask()] }),
      getTask: async () => ({ ok: true as const, ...fakeTaskDetail() }),
    })
    withProviders(api, <LedgerScreen />)
    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    await screen.findByText('实现台账列表与详情')
    await waitFor(() => expect(screen.queryByTestId('report-section')).toBeNull())
  })

  it('supervisor（非 assignee）：无汇报入口，但有验收入口', async () => {
    const api = createFakeCadreApi({
      whoami: async () => ({
        ok: true as const,
        apiVersion: 'cadre-heihei/1' as const,
        projectId: fakeIds.projectId,
        sessionId: 'session-supervisor' as never,
        role: 'supervisor' as const,
        projectName: 'demo',
      }),
      listTasks: async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [fakeTask()] }),
      getTask: async () => ({ ok: true as const, ...fakeTaskDetail() }),
    })
    withProviders(api, <LedgerScreen />)
    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    await screen.findByText('实现台账列表与详情')
    await waitFor(() => {
      expect(screen.queryByTestId('report-section')).toBeNull()
      expect(screen.queryByTestId('review-section')).not.toBeNull()
    })
  })

  it('worker：无验收入口（review-section 不渲染）', async () => {
    const api = createFakeCadreApi({
      whoami: async () => ({
        ok: true as const,
        apiVersion: 'cadre-heihei/1' as const,
        projectId: fakeIds.projectId,
        sessionId: fakeIds.sessionId,
        role: 'worker' as const,
        projectName: 'demo',
      }),
      listTasks: async () => ({ ok: true as const, apiVersion: 'cadre-heihei/1' as const, items: [fakeTask()] }),
      getTask: async () => ({ ok: true as const, ...fakeTaskDetail() }),
    })
    withProviders(api, <LedgerScreen />)
    fireEvent.click(await screen.findByTestId('task-row-task-1'))
    await screen.findByText('实现台账列表与详情')
    await waitFor(() => expect(screen.queryByTestId('review-section')).toBeNull())
  })
})
