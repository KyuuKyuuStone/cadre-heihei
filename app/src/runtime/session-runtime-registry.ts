/**
 * 会话运行时注册表（M2 §1.1/§1.4/§4.4）。
 *
 * 职责边界：
 * - 每会话独立 runtime/dshHome/patch；patch 生成与回收在本层；
 * - 运行时启停、working directory、显式 resume 委托 HarnessAdapter；
 * - 不复制台账/任务状态机；这里只记录 runtime 自身状态；
 * - stop/失败不自动重启；rebuild 只能由上层显式调用。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HarnessAdapter,
  type HarnessAdapterOptions,
  type HarnessRuntimeCreateInput,
} from '../adapters/engine/harness/index.ts'
import type { EngineSession, EngineSessionSummary } from '../ports/engine.ts'
import type { IsoTimestamp, ProjectId, SessionId } from '../collab/protocol/ids.ts'
import { RuntimeRegistryError } from './errors.ts'
import {
  DEFAULT_NODE_COMMAND,
  DEFAULT_SERVER_NAME,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  archiveSessionPatches,
  writeSessionPatches,
  type RuntimeRole,
} from './patches.ts'

const DEFAULT_MCP_SERVER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../mcp/server.ts')

export type RuntimeState = EngineSessionSummary['state']

export interface RuntimeAdapter {
  start(): Promise<void>
  stop(): Promise<void>
  createSessionWithRuntime(input: HarnessRuntimeCreateInput): Promise<EngineSession>
  rebuildSession(
    sessionId: SessionId,
    options: {
      readonly workingDirectory?: string
      readonly patchPaths: readonly string[]
      readonly force?: boolean
    },
  ): Promise<EngineSession>
  sessionState?(sessionId: SessionId): EngineSessionSummary['state'] | undefined
}

export interface SessionRuntimeRegistryOptions {
  readonly dshHomeBase: string
  readonly patchDirBase: string
  readonly patchArchiveBase?: string
  readonly mcpServerPath?: string
  readonly databasePathFor?: (projectId: ProjectId, sessionId: SessionId) => string
  readonly databaseBase?: string
  readonly nodeCommand?: string
  readonly serverName?: string
  readonly toolCallTimeoutMs?: number
  readonly adapter?: RuntimeAdapter
  readonly adapterOptions?: Omit<HarnessAdapterOptions, 'dshHomeBase'>
}

export interface RuntimeSessionSpec {
  readonly projectId: ProjectId
  readonly sessionId?: SessionId
  readonly role: RuntimeRole
  readonly workingDirectory: string
  readonly title?: string
  /** 覆盖 databasePathFor/databaseBase；用于同一项目共享库或测试隔离。 */
  readonly databasePath?: string
}

export interface RuntimeSessionRecord {
  readonly sessionId: SessionId
  readonly runtimeId: string
  readonly projectId: ProjectId
  readonly role: RuntimeRole
  readonly dshHome: string
  readonly databasePath: string
  readonly patchDir: string
  readonly patchPaths: readonly string[]
  readonly archivedPatchPaths: readonly string[]
  readonly state: RuntimeState
  readonly workingDirectory: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface RuntimeSessionHandle {
  readonly session: EngineSession
  readonly record: RuntimeSessionRecord
}

interface RegistryEntry {
  readonly sessionId: SessionId
  readonly runtimeId: string
  readonly projectId: ProjectId
  readonly role: RuntimeRole
  readonly dshHome: string
  readonly databasePath: string
  readonly patchDir: string
  readonly createdAt: IsoTimestamp
  session: EngineSession
  patchPaths: readonly string[]
  archivedPatchPaths: readonly string[]
  state: RuntimeState
  workingDirectory: string
  updatedAt: IsoTimestamp
}

function now(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp
}

function requireText(value: unknown, field: string, rawCode: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', `${field} must be a non-empty string`, false, rawCode)
  }
  return value
}

function snapshot(entry: RegistryEntry): RuntimeSessionRecord {
  return {
    sessionId: entry.sessionId,
    runtimeId: entry.runtimeId,
    projectId: entry.projectId,
    role: entry.role,
    dshHome: entry.dshHome,
    databasePath: entry.databasePath,
    patchDir: entry.patchDir,
    patchPaths: [...entry.patchPaths],
    archivedPatchPaths: [...entry.archivedPatchPaths],
    state: entry.state,
    workingDirectory: entry.workingDirectory,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export class SessionRuntimeRegistry {
  private readonly dshHomeBase: string
  private readonly patchDirBase: string
  private readonly patchArchiveBase: string
  private readonly mcpServerPath: string
  private readonly nodeCommand: string
  private readonly serverName: string
  private readonly toolCallTimeoutMs: number
  private readonly databasePathFor: ((projectId: ProjectId, sessionId: SessionId) => string) | undefined
  private readonly databaseBase: string | undefined
  private readonly adapter: RuntimeAdapter
  private readonly entries = new Map<SessionId, RegistryEntry>()
  private status: 'idle' | 'running' | 'stopped' = 'idle'

  constructor(options: SessionRuntimeRegistryOptions) {
    this.dshHomeBase = requireText(options.dshHomeBase, 'dshHomeBase', 'INVALID_REGISTRY_OPTIONS')
    this.patchDirBase = requireText(options.patchDirBase, 'patchDirBase', 'INVALID_REGISTRY_OPTIONS')
    this.patchArchiveBase = options.patchArchiveBase ?? join(this.patchDirBase, 'archive')
    this.mcpServerPath = options.mcpServerPath ?? DEFAULT_MCP_SERVER_PATH
    this.nodeCommand = options.nodeCommand ?? DEFAULT_NODE_COMMAND
    this.serverName = options.serverName ?? DEFAULT_SERVER_NAME
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    this.databasePathFor = options.databasePathFor
    this.databaseBase = options.databaseBase
    this.adapter = options.adapter ??
      new HarnessAdapter({ ...(options.adapterOptions ?? {}), dshHomeBase: this.dshHomeBase })
  }

  async start(): Promise<void> {
    if (this.status === 'running') return
    if (this.status === 'stopped') {
      throw new RuntimeRegistryError(
        'ENGINE_UNAVAILABLE',
        'registry is stopped; create a new registry instead of restarting it',
        false,
        'REGISTRY_STOPPED',
      )
    }
    await this.adapter.start()
    this.status = 'running'
  }

  async createSession(spec: RuntimeSessionSpec): Promise<RuntimeSessionHandle> {
    this.ensureRunning()
    const projectId = spec.projectId
    requireText(projectId, 'projectId', 'MISSING_PROJECT_ID')
    if (spec.role !== 'supervisor' && spec.role !== 'worker') {
      throw new RuntimeRegistryError('ENGINE_PROTOCOL', `invalid role: ${String(spec.role)}`, false, 'INVALID_ROLE')
    }
    const workingDirectory = requireText(spec.workingDirectory, 'workingDirectory', 'MISSING_WORKDIR')
    const sessionId = spec.sessionId ?? (`session-${randomUUID()}` as SessionId)
    requireText(sessionId, 'sessionId', 'MISSING_SESSION_ID')
    if (this.entries.has(sessionId)) {
      throw new RuntimeRegistryError('ENGINE_PROTOCOL', `session ${String(sessionId)} already registered`, false, 'SESSION_EXISTS')
    }
    const runtimeId = `runtime-${randomUUID()}`
    const dshHome = join(this.dshHomeBase, runtimeId)
    const databasePath = this.resolveDatabasePath(spec, projectId, sessionId)
    if (!existsSync(this.mcpServerPath)) {
      throw new RuntimeRegistryError(
        'ENGINE_UNAVAILABLE',
        `MCP server path does not exist: ${this.mcpServerPath}`,
        false,
        'PATCH_MISSING_SERVER',
      )
    }

    mkdirSync(this.dshHomeBase, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(dirname(databasePath), { recursive: true })
    mkdirSync(this.patchDirBase, { recursive: true })

    const patches = writeSessionPatches({
      runtimeId,
      role: spec.role,
      patchDirBase: this.patchDirBase,
      sessionId: String(sessionId),
      projectId: String(projectId),
      databasePath,
      serverPath: this.mcpServerPath,
      serverName: this.serverName,
      nodeCommand: this.nodeCommand,
      toolCallTimeoutMs: this.toolCallTimeoutMs,
    })

    let session: EngineSession
    try {
      session = await this.adapter.createSessionWithRuntime({
        sessionId,
        projectId,
        role: spec.role,
        runtimeId,
        dshHome,
        patchPaths: patches.patchPaths,
        databasePath,
        workingDirectory,
        ...(spec.title === undefined ? {} : { title: spec.title }),
      })
    } catch (error) {
      this.archiveQuietly(patches.patchPaths, runtimeId)
      throw error
    }

    let actualWorkingDirectory = workingDirectory
    try {
      actualWorkingDirectory = await session.getWorkingDirectory()
    } catch (error) {
      try {
        await session.close()
      } catch {
        // 保留原始错误。
      }
      this.archiveQuietly(patches.patchPaths, runtimeId)
      throw error
    }

    const at = now()
    const entry: RegistryEntry = {
      sessionId,
      runtimeId,
      projectId,
      role: spec.role,
      dshHome,
      databasePath,
      patchDir: patches.patchDir,
      createdAt: at,
      session,
      patchPaths: patches.patchPaths,
      archivedPatchPaths: [],
      state: 'ready',
      workingDirectory: actualWorkingDirectory,
      updatedAt: at,
    }
    this.entries.set(sessionId, entry)
    return { session, record: snapshot(entry) }
  }

  /**
   * 显式重建：默认强制重建（即使 registry/adapter 状态都是 ready）。
   * 原因：MCP 子进程崩溃后 harness 会话仍可能是 ready，状态位无法表达“工具已死”；
   * 调用方显式 rebuild 即要求重建，不能幂等早退。需要幂等语义请用
   * `rebuildSessionIfNeeded`。
   */
  async rebuildSession(
    sessionId: SessionId,
    options?: { readonly force?: boolean },
  ): Promise<EngineSession> {
    this.ensureRunning()
    const entry = this.requireEntry(sessionId)
    const force = options?.force !== false
    if (!force) {
      const adapterState = this.adapter.sessionState?.(sessionId)
      if (entry.state === 'ready' && (adapterState === undefined || adapterState === 'ready')) {
        return entry.session
      }
    }

    let patchPaths = entry.archivedPatchPaths.length > 0 ? entry.archivedPatchPaths : entry.patchPaths
    if (patchPaths.length === 0 || patchPaths.some((path) => !existsSync(path))) {
      const regenerated = writeSessionPatches({
        runtimeId: entry.runtimeId,
        role: entry.role,
        patchDirBase: this.patchDirBase,
        sessionId: String(entry.sessionId),
        projectId: String(entry.projectId),
        databasePath: entry.databasePath,
        serverPath: this.mcpServerPath,
        serverName: this.serverName,
        nodeCommand: this.nodeCommand,
        toolCallTimeoutMs: this.toolCallTimeoutMs,
      })
      patchPaths = regenerated.patchPaths
      entry.patchPaths = regenerated.patchPaths
      entry.archivedPatchPaths = []
    }

    let session: EngineSession
    try {
      session = await this.adapter.rebuildSession(sessionId, {
        workingDirectory: entry.workingDirectory,
        patchPaths,
        force,
      })
    } catch (error) {
      entry.state = 'failed'
      entry.updatedAt = now()
      throw error
    }
    entry.session = session
    entry.patchPaths = patchPaths
    entry.state = 'ready'
    entry.updatedAt = now()
    try {
      entry.workingDirectory = await session.getWorkingDirectory()
    } catch {
      // rebuild 已成功；workingDirectory 查询失败不改变 ready 结论。
    }
    return session
  }

  /** 显式幂等语义：仅当 registry/adapter 都 ready 时复用；怀疑工具已死请用 rebuildSession。 */
  async rebuildSessionIfNeeded(sessionId: SessionId): Promise<EngineSession> {
    return this.rebuildSession(sessionId, { force: false })
  }

  /** 关闭 runtime 并归档 patch；重复调用幂等。 */
  async reclaimSession(sessionId: SessionId): Promise<void> {
    const entry = this.requireEntry(sessionId)
    let closeError: unknown
    if (entry.state !== 'closed') {
      try {
        await entry.session.close()
      } catch (error) {
        closeError = error
      }
    }
    try {
      this.archiveEntry(entry)
    } catch (error) {
      entry.state = 'failed'
      entry.updatedAt = now()
      throw error
    }
    entry.state = closeError === undefined ? 'closed' : 'failed'
    entry.updatedAt = now()
    if (closeError !== undefined) {
      const message = closeError instanceof Error ? closeError.message : String(closeError)
      throw new RuntimeRegistryError(
        'ENGINE_UNAVAILABLE',
        `session close failed during reclaim: ${message}`,
        false,
        'SESSION_CLOSE_FAILED',
      )
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'stopped'
    let firstError: unknown
    try {
      await this.adapter.stop()
    } catch (error) {
      firstError = error
    }
    for (const entry of this.entries.values()) {
      try {
        this.archiveEntry(entry)
        entry.state = 'closed'
        entry.updatedAt = now()
      } catch (error) {
        entry.state = 'failed'
        entry.updatedAt = now()
        if (firstError === undefined) firstError = error
      }
    }
    if (firstError !== undefined) throw firstError
  }

  listRuntimes(): readonly RuntimeSessionRecord[] {
    const records: RuntimeSessionRecord[] = []
    for (const entry of this.entries.values()) {
      const adapterState = this.adapter.sessionState?.(entry.sessionId)
      if (adapterState !== undefined) entry.state = adapterState
      records.push(snapshot(entry))
    }
    return records
  }

  getRuntime(sessionId: SessionId): RuntimeSessionRecord | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    const adapterState = this.adapter.sessionState?.(sessionId)
    if (adapterState !== undefined) entry.state = adapterState
    return snapshot(entry)
  }

  getSession(sessionId: SessionId): EngineSession | undefined {
    return this.entries.get(sessionId)?.session
  }

  private ensureRunning(): void {
    if (this.status !== 'running') {
      throw new RuntimeRegistryError(
        'ENGINE_UNAVAILABLE',
        `registry is ${this.status}; call start() before creating/rebuilding sessions`,
        false,
        'REGISTRY_NOT_RUNNING',
      )
    }
  }

  private requireEntry(sessionId: SessionId): RegistryEntry {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) {
      throw new RuntimeRegistryError(
        'ENGINE_UNAVAILABLE',
        `session ${String(sessionId)} is not registered`,
        false,
        'SESSION_NOT_IN_REGISTRY',
      )
    }
    return entry
  }

  private resolveDatabasePath(spec: RuntimeSessionSpec, projectId: ProjectId, sessionId: SessionId): string {
    const configured = spec.databasePath ?? this.databasePathFor?.(projectId, sessionId)
    if (configured !== undefined) {
      return requireText(configured, 'databasePath', 'MISSING_DATABASE_PATH')
    }
    if (this.databaseBase !== undefined) {
      return join(this.databaseBase, String(projectId), 'cadre.sqlite')
    }
    throw new RuntimeRegistryError(
      'ENGINE_PROTOCOL',
      'database path is required (databasePathFor/databaseBase or per-session databasePath)',
      false,
      'MISSING_DATABASE_PATH',
    )
  }

  private archiveEntry(entry: RegistryEntry): void {
    const result = archiveSessionPatches(entry.patchPaths, join(this.patchArchiveBase, entry.runtimeId))
    if (result.archivedPaths.length > 0) {
      entry.archivedPatchPaths = result.archivedPaths
    }
  }

  private archiveQuietly(activePaths: readonly string[], runtimeId: string): void {
    try {
      archiveSessionPatches(activePaths, join(this.patchArchiveBase, runtimeId))
    } catch {
      // 创建失败时优先保留原始错误；归档失败不静默变成成功。
    }
  }
}
