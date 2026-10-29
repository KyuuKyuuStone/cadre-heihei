import { afterEach, expect, it, vi } from 'vitest'
import {
  actCadreStall,
  fetchCadreStallView,
  type CadreStallActionRequest,
} from '../src/client/cadre-stall.ts'

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
