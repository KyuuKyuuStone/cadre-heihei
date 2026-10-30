import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  actCadreStall,
  assertCadreStallTaskView,
  executionOf,
  fetchCadreStallView,
  summarizeStalls,
  type CadreStallActionRequest,
  type CadreStallTaskView,
} from '../src/client/cadre-stall.ts'
import type { StallTaskView as HostStallTaskView } from '@deepseek-ai/dsh-host-governance'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('posts the project and actor to the real snapshot route', async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    tasks: [],
    thresholds: { nudgeCooldownMs: 60_000 },
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  const view = await fetchCadreStallView({ projectId: 'p1', actorSessionId: 'sup-1' })
  expect(view.thresholds?.nudgeCooldownMs).toBe(60_000)
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe('/cadre/stall/snapshot')
  const body = init?.body
  if (typeof body !== 'string') throw new Error('snapshot body must be JSON text')
  expect(JSON.parse(body)).toEqual({ projectId: 'p1', actorSessionId: 'sup-1' })
})

const FIXTURE = JSON.parse(readFileSync(new URL(
  '../../../cadre/host-governance/tests/fixtures/stall-view-contract.json',
  import.meta.url,
), 'utf8')) as {
  readonly generation: Partial<CadreStallTaskView>
  readonly tool: Partial<CadreStallTaskView>
}

const NO_EVENTS_BASIS: NonNullable<CadreStallTaskView['stallBasis']> = {
  kind: 'no_events', since: '2026-10-30T03:00:00.000Z', stepKind: null,
  toolName: null, elapsedMs: 0, heartbeatAgeMs: 0, evidenceEventSeq: null,
}

function realView(overrides: Partial<CadreStallTaskView> = {}): CadreStallTaskView {
  const view: CadreStallTaskView = {
    taskId: 'task-1',
    title: '真实任务',
    taskStatus: 'in_progress',
    assigneeSessionId: 'w1',
    assigneeName: '走查前端',
    assigneeRole: 'worker',
    lastActivityAt: 1_700_000_000_000,
    lastActivityKind: 'assistant',
    silenceMs: null,
    stallState: 'normal',
    stateSince: 1_700_000_000_000,
    episodeId: 'task-1:episode',
    nudgeCount: 0,
    lastNudgedAt: null,
    suggestedAction: null,
    capabilities: { nudge: false, reassign: false, cancel: false, escalate: false },
    version: 3,
    stale: false,
    updatedAt: '2026-10-30T03:00:00.000Z',
    elapsedMs: null,
    heartbeatAt: null,
    firstTokenAt: null,
    tokensSoFar: null,
    stallBasis: NO_EVENTS_BASIS,
    inferred: false,
    ...overrides,
  }
  // A partial fixture may omit this optional-shaped field by accident; the
  // baseline view must still be a valid no_events contract for both tests.
  return view.stallBasis === undefined ? { ...view, stallBasis: NO_EVENTS_BASIS } : view
}

it('accepts no_events and real generation views without a false contract error', () => {
  const noEvents: HostStallTaskView = realView()
  const generation: HostStallTaskView = realView(FIXTURE.generation)
  expect(() => { assertCadreStallTaskView(noEvents) }).not.toThrow()
  expect(() => { assertCadreStallTaskView(generation) }).not.toThrow()
  expect(executionOf(noEvents)).toBeNull()
  expect(executionOf(generation)?.state).toBe('model_generation')
})

it('consumes the checked-in stall-view fixture for generation and tool', () => {
  const generation = realView(FIXTURE.generation)
  const tool = realView(FIXTURE.tool)
  expect(() => { assertCadreStallTaskView(generation) }).not.toThrow()
  expect(executionOf(generation)).toMatchObject({
    state: 'model_generation', elapsedMs: 420_000, heartbeatAt: 1793275200000,
  })
  expect(executionOf(tool)).toMatchObject({
    state: 'tool_execution', toolName: 'docx_build', elapsedMs: 210_000,
  })
  expect(executionOf(realView({ ...FIXTURE.tool, elapsedMs: null }))?.elapsedMs).toBe(210_000)
})

it('fails the contract when a required view field is missing', () => {
  const incomplete = { ...realView() } as Record<string, unknown>
  delete incomplete.stallState
  expect(() => { assertCadreStallTaskView(incomplete) }).toThrow('STALL_VIEW_CONTRACT_MISSING:stallState')
  const noBasis = { ...realView() } as Record<string, unknown>
  delete noBasis.stallBasis
  expect(() => { assertCadreStallTaskView(noBasis) }).toThrow('STALL_VIEW_CONTRACT_MISSING:stallBasis')
})

it('fails the contract for an unknown stallBasis kind', () => {
  const view = realView({
    stallBasis: {
      kind: 'bogus' as never, since: '2026-10-30T03:00:00.000Z', stepKind: null,
      toolName: null, elapsedMs: 0, heartbeatAgeMs: 0, evidenceEventSeq: null,
    },
  })
  expect(() => { assertCadreStallTaskView(view) }).toThrow('STALL_VIEW_CONTRACT_INVALID:stallBasis.kind')
})

it('fails the contract when a stallBasis execution claim lacks step fields', () => {
  expect(() => { assertCadreStallTaskView(realView({
    stallBasis: {
      kind: 'model_generation', since: '2026-10-30T03:00:00.000Z', stepKind: null,
      toolName: null, elapsedMs: 1, heartbeatAgeMs: 1, evidenceEventSeq: null,
    },
  })) }).toThrow('STALL_VIEW_CONTRACT_MISSING:stallBasis.stepKind')
  expect(() => { assertCadreStallTaskView(realView({
    stallBasis: {
      kind: 'tool_execution', since: '2026-10-30T03:00:00.000Z', stepKind: 'tool_execution',
      toolName: null, elapsedMs: 1, heartbeatAgeMs: 1, evidenceEventSeq: null,
    },
  })) }).toThrow('STALL_VIEW_CONTRACT_MISSING:stallBasis.toolName')
  expect(() => { assertCadreStallTaskView(realView()) }).not.toThrow()
  expect(executionOf(realView())).toBeNull()
})

it('derives model generation progress from the real flat view fields', () => {
  const view = realView({
    elapsedMs: 180_000,
    heartbeatAt: 1_700_000_000_030,
    firstTokenAt: 1_700_000_000_010,
    tokensSoFar: 128,
    stallBasis: {
      kind: 'model_generation', since: '2026-10-30T03:00:00.000Z', stepKind: 'model_generation',
      toolName: null, elapsedMs: 180_000, heartbeatAgeMs: 30_000, evidenceEventSeq: 10,
    },
  })
  expect(executionOf(view, 1_700_000_180_000)).toMatchObject({
    state: 'model_generation',
    elapsedMs: 180_000,
    firstTokenAt: 1_700_000_000_010,
    tokensSoFar: 128,
  })
  expect(summarizeStalls([view], 1_700_000_180_000).get('w1')?.execution?.state).toBe('model_generation')
})

it('derives tool execution from stepKind/toolName and keeps no_events as a stall candidate', () => {
  const tool = realView({
    elapsedMs: 210_000,
    stallBasis: {
      kind: 'tool_execution', since: '2026-10-30T03:00:00.000Z', stepKind: 'tool_execution',
      toolName: 'office_docx', elapsedMs: 210_000, heartbeatAgeMs: 15_000, evidenceEventSeq: 11,
    },
  })
  expect(executionOf(tool, 1_700_000_210_000)).toMatchObject({
    state: 'tool_execution',
    toolName: 'office_docx',
    elapsedMs: 210_000,
  })
  expect(executionOf(realView(), 1_700_000_000_000)).toBeNull()
})

it('posts every host action field, including project/actor/action', async () => {
  const result = { ok: true, action: 'reassign', version: 9, replayed: false }
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(result), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const request: CadreStallActionRequest = {
    action: 'reassign',
    projectId: 'p1',
    taskId: 'task-1',
    episodeId: 'task-1:episode',
    expectedVersion: 7,
    idempotencyKey: 'idem-1',
    actorSessionId: 'sup-1',
    toSessionId: 'w2',
    reason: '换人继续',
  }
  await expect(actCadreStall(request)).resolves.toEqual(result)
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe('/cadre/stall/action')
  const body = init?.body
  if (typeof body !== 'string') throw new Error('action body must be JSON text')
  expect(JSON.parse(body)).toEqual(request)
})

it('surfaces a snapshot permission failure instead of treating it as empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: false, code: 'PERMISSION_DENIED', message: '只有本项目在册 supervisor 可以查看停摆视图',
  }), { status: 403 })))
  await expect(fetchCadreStallView({ projectId: 'p1', actorSessionId: 'w1' }))
    .rejects.toThrow('PERMISSION_DENIED · 只有本项目在册 supervisor 可以查看停摆视图')
})

it('surfaces an action failure response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: false, code: 'NUDGE_COOLDOWN', message: '催办冷却中',
  }), { status: 409 })))
  await expect(actCadreStall({
    action: 'nudge', projectId: 'p1', taskId: 'task-1', episodeId: 'task-1:episode',
    expectedVersion: 7, idempotencyKey: 'idem-2', actorSessionId: 'sup-1',
  })).resolves.toEqual({ ok: false, code: 'NUDGE_COOLDOWN', message: '催办冷却中' })
})
