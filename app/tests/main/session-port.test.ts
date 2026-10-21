/** SessionPort.ensure：ready 复用、缺失创建、failed 不自动重建。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EngineSession } from '../../src/ports/engine.ts'
import type { SessionRuntimeRegistry } from '../../src/runtime/session-runtime-registry.ts'
import { RegistrySessionPort } from '../../src/main/session-port.ts'

const SID = 'session-1' as never
const identity = { projectId: 'p1', sessionId: 'session-1', role: 'worker' } as const
const session = { sessionId: SID } as unknown as EngineSession

function fakeRegistry(runtimeState: string | undefined) {
  const calls: Array<{ kind: string; value: unknown }> = []
  const registry = {
    getRuntime(sessionId: unknown) {
      calls.push({ kind: 'getRuntime', value: sessionId })
      return runtimeState === undefined ? undefined : { state: runtimeState, sessionId }
    },
    getSession(sessionId: unknown) {
      calls.push({ kind: 'getSession', value: sessionId })
      return runtimeState === 'ready' ? session : undefined
    },
    async createSession(spec: unknown) {
      calls.push({ kind: 'createSession', value: spec })
      return { session, record: {} }
    },
    async rebuildSession(sessionId: unknown, options: unknown) {
      calls.push({ kind: 'rebuildSession', value: { sessionId, options } })
      return session
    },
    async reclaimSession(sessionId: unknown) {
      calls.push({ kind: 'reclaimSession', value: sessionId })
    },
  }
  return { registry: registry as unknown as SessionRuntimeRegistry, calls }
}

function makePort(runtimeState: string | undefined) {
  const fake = fakeRegistry(runtimeState)
  const port = new RegistrySessionPort({
    registry: fake.registry,
    workingDirectory: 'C:/work',
    databasePath: 'C:/db/cadre.sqlite',
  })
  return { port, calls: fake.calls }
}

test('ensure：ready runtime 复用，不 create', async () => {
  const { port, calls } = makePort('ready')
  assert.equal(await port.ensure(identity as never), session)
  assert.equal(calls.some((call) => call.kind === 'createSession'), false)
})

test('ensure：无 runtime → createSession 带项目/会话/角色/库路径', async () => {
  const { port, calls } = makePort(undefined)
  assert.equal(await port.ensure(identity as never), session)
  const created = calls.find((call) => call.kind === 'createSession')!.value as Record<string, unknown>
  assert.equal(created.projectId, 'p1')
  assert.equal(created.sessionId, 'session-1')
  assert.equal(created.role, 'worker')
  assert.equal(created.workingDirectory, 'C:/work')
  assert.equal(created.databasePath, 'C:/db/cadre.sqlite')
})

test('ensure：failed runtime 不自动重建，直接报错', async () => {
  const { port, calls } = makePort('failed')
  await assert.rejects(() => port.ensure(identity as never), /state=failed/)
  assert.equal(calls.some((call) => call.kind === 'createSession'), false)
  assert.equal(calls.some((call) => call.kind === 'rebuildSession'), false)
})

test('get/rebuild/reclaim 委托 registry；rebuild 强制', async () => {
  const { port, calls } = makePort('ready')
  assert.equal(port.get(SID), session)
  await port.rebuild(SID)
  const rebuild = calls.find((call) => call.kind === 'rebuildSession')!
  assert.deepEqual(rebuild.value, { sessionId: SID, options: { force: true } })
  await port.reclaim(SID)
  assert.ok(calls.some((call) => call.kind === 'reclaimSession'))
})
