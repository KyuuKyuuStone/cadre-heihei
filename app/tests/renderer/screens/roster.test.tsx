import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RosterResponse } from '../../../src/collab/protocol/roster.ts'
import { CadreApiProvider } from '../../../src/renderer/data/CadreApiProvider.tsx'
import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import { LocaleProvider } from '../../../src/renderer/i18n/LocaleProvider.tsx'
import { RosterScreen } from '../../../src/renderer/screens/roster/RosterScreen.tsx'
import { createFakeCadreApi, fakeFailure, fakeIds } from '../data/fake-api.ts'

function renderRoster(api: CadreApi) {
  return render(
    <CadreApiProvider api={api}>
      <LocaleProvider initialLocale="zh">
        <RosterScreen />
      </LocaleProvider>
    </CadreApiProvider>,
  )
}

function roster(overrides: Partial<RosterResponse> = {}): RosterResponse {
  return {
    ok: true,
    apiVersion: 'cadre-heihei/1',
    projects: [],
    members: [],
    scope: {
      scope: { kind: 'project', projectId: fakeIds.projectId },
      globalCount: 49,
      dispatchableCount: 0,
      projectMatched: true,
      reason: 'no_workers_in_project',
      hint: '添加员工或切换项目。',
    },
    ...overrides,
  }
}

describe('RosterScreen 双口径', () => {
  it('同屏显示全局在册与本项目可用，且本项目为 0 时给提示', async () => {
    renderRoster(createFakeCadreApi({ listRoster: async () => roster() }))

    expect(await screen.findByText('全局在册：49')).toBeTruthy()
    expect(screen.getByText('本项目可用：0')).toBeTruthy()
    expect(screen.getByTestId('roster-global-only-hint')).toBeTruthy()
    // 空成员是合法初始态：显示引导，不是错误。
    expect(screen.getByText('暂无可用员工')).toBeTruthy()
    expect(screen.getByText('添加员工或切换项目。')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('渲染成员角色/状态，并标出不可派活', async () => {
    renderRoster(createFakeCadreApi({
      listRoster: async () => roster({
        scope: {
          scope: { kind: 'project', projectId: fakeIds.projectId },
          globalCount: 3,
          dispatchableCount: 1,
          projectMatched: true,
        },
        members: [
          {
            sessionId: fakeIds.sessionId,
            displayName: '前端员工',
            role: 'worker',
            state: 'available',
            projectId: fakeIds.projectId,
            dispatchable: true,
          },
          {
            sessionId: 'session-2' as typeof fakeIds.sessionId,
            displayName: '离线员工',
            role: 'worker',
            state: 'offline',
            projectId: fakeIds.projectId,
            dispatchable: false,
            dispatchableReason: 'offline',
          },
        ],
      }),
    }))

    expect(await screen.findByText('前端员工')).toBeTruthy()
    expect(screen.getByText('离线员工')).toBeTruthy()
    const available = screen.getByTestId('member-session-1')
    expect(available.textContent).toContain('员工')
    expect(available.textContent).toContain('可用')
    const offline = screen.getByTestId('member-session-2-not-dispatchable')
    expect(offline.textContent).toContain('不可派活')
    expect(offline.textContent).toContain('offline')
  })

  it('跨项目拒绝显示 denied', async () => {
    renderRoster(createFakeCadreApi({
      listRoster: async () => fakeFailure('CROSS_PROJECT_DENIED', '跨项目拒绝'),
    }))

    expect(await screen.findByText('当前项目不可用')).toBeTruthy()
    expect(screen.getByText('跨项目拒绝')).toBeTruthy()
  })
})
