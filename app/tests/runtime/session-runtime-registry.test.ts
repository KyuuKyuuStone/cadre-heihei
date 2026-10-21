import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HarnessRuntimeCreateInput } from '../../src/adapters/engine/harness/index.ts'
import type { ProjectId, SessionId } from '../../src/collab/protocol/ids.ts'
import type { EngineEvent, EngineSession, EngineSessionSummary } from '../../src/ports/engine.ts'
import { RuntimeRegistryError } from '../../src/runtime/errors.ts'
import {
  SessionRuntimeRegistry,
  type RuntimeAdapter,
} from '../../src/runtime/session-runtime-registry.ts'

interface RebuildOptions {
  readonly workingDirectory?: string
  readonly patchPaths: readonly string[]
}

class FakeSession implements EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId: string
  workingDirectory: string
  closed = false
  private readonly onClose: () => void

  constructor(sessionId: SessionId, runtimeId: string, workingDirectory: string, onClose: () => void) {
    this.sessionId = sessionId
    this.runtimeId = runtimeId
    this.workingDirectory = workingDirectory
    this.onClose = onClose
  }

  async *send(): AsyncIterable<EngineEvent> {
    // 单元测试不使用 send；保持空事件流。
  }

  async setWorkingDirectory(path: string): Promise<void> {
    this.workingDirectory = path
  }

  async getWorkingDirectory(): Promise<string> {
    return this.workingDirectory
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}

class FakeAdapter implements RuntimeAdapter {
  status: 'idle' | 'running' | 'stopped' = 'idle'
  created: HarnessRuntimeCreateInput[] = []
  rebuilt: Array<{ readonly sessionId: SessionId; readonly options: RebuildOptions }> = []
  states = new Map<SessionId, EngineSessionSummary['state']>()
  stopped = 0
  failCreate = false
  failRebuild = false

  async start(): Promise<void> {
    this.status = 'running'
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.status = 'stopped'
    for (const sessionId of this.states.keys()) this.states.set(sessionId, 'closed')
  }

  async createSessionWithRuntime(input: HarnessRuntimeCreateInput): Promise<EngineSession> {
    this.created.push(input)
    if (this.failCreate) throw new Error('fake create failure')
    this.states.set(input.sessionId, 'ready')
    return new FakeSession(input.sessionId, input.runtimeId, input.workingDirectory, () => {
      this.states.set(input.sessionId, 'closed')
    })
  }

  async rebuildSession(sessionId: SessionId, options: RebuildOptions): Promise<EngineSession> {
    if (this.failRebuild) {
      this.states.set(sessionId, 'failed')
      throw new Error('fake rebuild failure')
    }
    this.rebuilt.push({ sessionId, options })
    this.states.set(sessionId, 'ready')
    return new FakeSession(sessionId, 'runtime-rebuilt', options.workingDirectory ?? '', () => {
      this.states.set(sessionId, 'closed')
    })
  }

  sessionState(sessionId: SessionId): EngineSessionSummary['state'] | undefined {
    return this.states.get(sessionId)
  }
}

function setup(): {
  readonly root: string
  readonly adapter: FakeAdapter
  readonly registry: SessionRuntimeRegistry
} {
  const root = mkdtempSync(join(tmpdir(), 'cadre-registry-'))
  const serverPath = join(root, 'server.ts')
  writeFileSync(serverPath, '// dummy MCP server path for unit tests\n', 'utf8')
  const adapter = new FakeAdapter()
  const registry = new SessionRuntimeRegistry({
    dshHomeBase: join(root, 'homes'),
    patchDirBase: join(root, 'patches'),
    patchArchiveBase: join(root, 'archive'),
    mcpServerPath: serverPath,
    databaseBase: join(root, 'db'),
    adapter,
  })
  return { root, adapter, registry }
}

function spec(projectId: string, sessionId: string, role: 'supervisor' | 'worker', workingDirectory: string) {
  return {
    projectId: projectId as ProjectId,
    sessionId: sessionId as SessionId,
    role,
    workingDirectory,
  }
}

test('registry creates per-session runtime/patch and supervisor gets two patches', async () => {
  const { root, adapter, registry } = setup()
  try {
    const workA = join(root, 'work-a')
    const workB = join(root, 'work-b')
    mkdirSync(workA, { recursive: true })
    mkdirSync(workB, { recursive: true })
    await registry.start()
    const worker = await registry.createSession(spec('project-a', 'session-worker', 'worker', workA))
    const supervisor = await registry.createSession(spec('project-a', 'session-supervisor', 'supervisor', workB))

    assert.equal(worker.record.patchPaths.length, 1)
    assert.equal(supervisor.record.patchPaths.length, 2)
    assert.notEqual(worker.record.runtimeId, supervisor.record.runtimeId)
    assert.notEqual(worker.record.dshHome, supervisor.record.dshHome)
    assert.notEqual(worker.record.patchPaths[0], supervisor.record.patchPaths[0])
    assert.ok(readFileSync(worker.record.patchPaths[0] ?? '', 'utf8').includes('session-worker'))
    assert.ok(readFileSync(supervisor.record.patchPaths[0] ?? '', 'utf8').includes('session-supervisor'))
    assert.ok(readFileSync(supervisor.record.patchPaths[1] ?? '', 'utf8').includes('session-supervisor'))
    assert.equal(worker.record.databasePath, join(root, 'db', 'project-a', 'cadre.sqlite'))
    assert.equal(worker.record.state, 'ready')
    assert.equal(worker.record.workingDirectory, workA)
    assert.equal(adapter.created.length, 2)
    assert.equal(adapter.created[0]?.patchPaths.length, 1)
    assert.equal(adapter.created[1]?.patchPaths.length, 2)
    assert.equal(adapter.created[0]?.dshHome, worker.record.dshHome)
    assert.equal(adapter.created[1]?.dshHome, supervisor.record.dshHome)
    assert.deepEqual(registry.listRuntimes().map((record) => record.state), ['ready', 'ready'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registry fails closed before adapter when identity/db/server config is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-registry-fail-'))
  try {
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const serverPath = join(root, 'server.ts')
    writeFileSync(serverPath, '// dummy\n', 'utf8')
    const adapter = new FakeAdapter()
    const noDatabase = new SessionRuntimeRegistry({
      dshHomeBase: join(root, 'homes-1'),
      patchDirBase: join(root, 'patches-1'),
      mcpServerPath: serverPath,
      adapter,
    })
    await noDatabase.start()
    await assert.rejects(
      () => noDatabase.createSession(spec('project-a', 'session-a', 'worker', work)),
      (error: unknown) => error instanceof RuntimeRegistryError && error.rawCode === 'MISSING_DATABASE_PATH',
    )
    assert.equal(adapter.created.length, 0)

    const missingServer = new SessionRuntimeRegistry({
      dshHomeBase: join(root, 'homes-2'),
      patchDirBase: join(root, 'patches-2'),
      mcpServerPath: join(root, 'missing-server.ts'),
      databaseBase: join(root, 'db'),
      adapter,
    })
    await missingServer.start()
    await assert.rejects(
      () => missingServer.createSession(spec('project-a', 'session-b', 'worker', work)),
      (error: unknown) => error instanceof RuntimeRegistryError && error.rawCode === 'PATCH_MISSING_SERVER',
    )
    assert.equal(adapter.created.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter create failure leaves no registry entry and patches are archived', async () => {
  const { root, adapter, registry } = setup()
  try {
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    await registry.start()
    adapter.failCreate = true
    await assert.rejects(
      () => registry.createSession(spec('project-a', 'session-fail', 'worker', work)),
      /fake create failure/,
    )
    assert.equal(registry.listRuntimes().length, 0)
    const attempted = adapter.created[0]
    assert.ok(attempted !== undefined)
    assert.equal(existsSync(join(root, 'archive', attempted.runtimeId)), true)
    for (const patch of attempted.patchPaths) assert.equal(existsSync(patch), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reclaim closes/archives idempotently; rebuild uses archived patch and same dshHome; stop retains closed records', async () => {
  const { root, adapter, registry } = setup()
  try {
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    await registry.start()
    const created = await registry.createSession(spec('project-a', 'session-a', 'worker', work))
    const dshHome = created.record.dshHome
    const activePatch = created.record.patchPaths[0] ?? ''

    await registry.reclaimSession(created.session.sessionId)
    let record = registry.getRuntime(created.session.sessionId)
    assert.equal(record?.state, 'closed')
    assert.equal(existsSync(activePatch), false)
    assert.equal(record?.archivedPatchPaths.length, 1)
    assert.equal(existsSync(record?.archivedPatchPaths[0] ?? ''), true)
    await registry.reclaimSession(created.session.sessionId)
    record = registry.getRuntime(created.session.sessionId)
    assert.equal(record?.state, 'closed')

    const rebuilt = await registry.rebuildSession(created.session.sessionId)
    assert.equal(adapter.rebuilt.length, 1)
    assert.deepEqual(adapter.rebuilt[0]?.options.patchPaths, record?.archivedPatchPaths)
    record = registry.getRuntime(created.session.sessionId)
    assert.equal(record?.state, 'ready')
    assert.equal(record?.dshHome, dshHome)
    assert.equal(rebuilt.sessionId, created.session.sessionId)

    const other = await registry.createSession(spec('project-b', 'session-b', 'supervisor', work))
    await registry.stop()
    assert.equal(adapter.stopped, 1)
    assert.equal(registry.listRuntimes().every((item) => item.state === 'closed'), true)
    for (const patch of other.record.patchPaths) assert.equal(existsSync(patch), false)
    assert.ok((registry.getRuntime(other.session.sessionId)?.archivedPatchPaths.length ?? 0) > 0)
    await registry.stop()
    await assert.rejects(
      () => registry.createSession(spec('project-c', 'session-c', 'worker', work)),
      (error: unknown) => error instanceof RuntimeRegistryError && error.rawCode === 'REGISTRY_NOT_RUNNING',
    )
    await assert.rejects(
      () => registry.rebuildSession(created.session.sessionId),
      (error: unknown) => error instanceof RuntimeRegistryError && error.rawCode === 'REGISTRY_NOT_RUNNING',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild failure marks the runtime failed and does not auto-restart', async () => {
  const { root, adapter, registry } = setup()
  try {
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    await registry.start()
    const created = await registry.createSession(spec('project-a', 'session-a', 'worker', work))
    await registry.reclaimSession(created.session.sessionId)
    adapter.failRebuild = true
    await assert.rejects(() => registry.rebuildSession(created.session.sessionId), /fake rebuild failure/)
    assert.equal(registry.getRuntime(created.session.sessionId)?.state, 'failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

