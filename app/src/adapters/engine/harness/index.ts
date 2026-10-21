/**
 * HarnessAdapter —— EnginePort 的真实 harness 实现（W1-09 最小闭环）。
 *
 * 形态：
 * - 每会话独立 DeepSeekHarness 实例/runtime（ADR-0014），各自独立 dshHome；
 * - listSessions 只读产品自建台账，不调用 SDK 枚举（N7）；
 * - send 使用 SDK 高层 run() 的活动区间，在轮次 settle 后按事件顺序产出端口事件
 *   （不是 token 级实时流；harness 无 mid-turn cancel，abort 只能停止后续产出）；
 * - 未知事件走 mapping 诊断并由 logger 记录，不伪装成成功；
 * - 进程崩溃/关闭 → 显式 session.error，不自动重启（N6/N15/N16）；
 * - 本目录是唯一允许触碰 harness 的目录（R1）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CreateSessionInput,
  type EngineCapabilities,
  type EngineHealth,
  type EnginePort,
  type EngineSession,
  type EngineSessionSummary,
  type EngineEvent,
  type ResumeSessionInput,
  type SendOptions,
} from '../../../ports/engine.ts'
import type { IsoTimestamp, ProjectId, SessionId } from '../../../collab/protocol/ids.ts'
import {
  HarnessEngineError,
  mapHarnessError,
  mapHarnessEvents,
  type HarnessEventLike,
  type HarnessMappingDiagnostic,
} from './mapping.ts'
import {
  loadHarnessSdk,
  type HarnessLaunchOptions,
  type HarnessRuntimeLike,
  type HarnessSdkModule,
  type HarnessSessionLike,
} from './sdk.ts'

export interface HarnessAdapterOptions {
  /** 每个会话在此目录下创建独立 dshHome。 */
  readonly dshHomeBase: string
  /** 子进程环境；凭据由调用方注入，adapter 不读取密钥文件。 */
  readonly env?: NodeJS.ProcessEnv
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly initializeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** 可选；默认使用 SDK 解析的 pin 版本 dsh。 */
  readonly dshBin?: string
  /** 可选；默认 W1-02 submodule 的 SDK 构建产物。 */
  readonly sdkEntry?: string
  /** 诊断落地；默认 console.warn，只记 type/seq，不记原始 payload。 */
  readonly logger?: (diagnostic: HarnessMappingDiagnostic) => void
}

/**
 * 产品运行时注册表创建会话时的扩展输入。
 * `patchPaths` 必须由注册表按会话生成并存在；adapter 自身不生成 MCP/supervisor patch。
 */
export interface HarnessRuntimeCreateInput extends CreateSessionInput {
  readonly sessionId: SessionId
  readonly projectId?: ProjectId
  readonly role?: 'supervisor' | 'worker'
  readonly runtimeId: string
  readonly dshHome: string
  readonly patchPaths: readonly string[]
  readonly databasePath?: string
}

type SessionState = EngineSessionSummary['state']

interface SessionRecord {
  readonly sessionId: SessionId
  readonly runtimeId: string
  workingDirectory: string
  readonly dshHome: string
  harness: HarnessRuntimeLike
  harnessSession: HarnessSessionLike
  /** 本次 runtime 启动使用的 per-session patch；空数组表示端口直连（无 MCP）。 */
  patchPaths: readonly string[]
  state: SessionState
  readonly createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  readonly title?: string
}

function now(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp
}

function defaultLogger(diagnostic: HarnessMappingDiagnostic): void {
  const seq = diagnostic.seq === undefined ? '' : `#${diagnostic.seq}`
  console.warn(`[harness-adapter] ${diagnostic.kind} ${diagnostic.eventType}${seq}: ${diagnostic.detail}`)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

class HarnessEngineSession implements EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId: string
  private readonly adapter: HarnessAdapter
  private readonly record: SessionRecord

  constructor(adapter: HarnessAdapter, record: SessionRecord) {
    this.adapter = adapter
    this.record = record
    this.sessionId = record.sessionId
    this.runtimeId = record.runtimeId
  }

  send(prompt: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    return this.adapter.sendForSession(this.record, prompt, options)
  }

  setWorkingDirectory(path: string): Promise<void> {
    return this.adapter.setWorkingDirectory(this.record, path)
  }

  getWorkingDirectory(): Promise<string> {
    return this.adapter.getWorkingDirectory(this.record)
  }

  close(): Promise<void> {
    return this.adapter.closeSession(this.record)
  }
}

export class HarnessAdapter implements EnginePort {
  readonly engineId = 'harness' as const
  private readonly options: HarnessAdapterOptions
  private readonly logger: (diagnostic: HarnessMappingDiagnostic) => void
  private readonly sessions = new Map<SessionId, SessionRecord>()
  private sdk: HarnessSdkModule | undefined
  private status: 'idle' | 'running' | 'stopped' = 'idle'

  constructor(options: HarnessAdapterOptions) {
    this.options = options
    this.logger = options.logger ?? defaultLogger
  }

  async start(): Promise<void> {
    if (this.status === 'running') return
    if (this.status === 'stopped') {
      // N6/N15/N16：停止是终态，不自动恢复；重启由上层重建 adapter。
      throw new HarnessEngineError(
        'ENGINE_UNAVAILABLE',
        'HarnessAdapter is stopped; create and start a new adapter instead of restarting this one',
        false,
        'ADAPTER_STOPPED',
      )
    }
    this.sdk = await loadHarnessSdk({ ...(this.options.sdkEntry === undefined ? {} : { sdkEntry: this.options.sdkEntry }) })
    this.status = 'running'
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'stopped'
    let firstError: unknown
    for (const record of this.sessions.values()) {
      try {
        await record.harness.close()
      } catch (error) {
        if (firstError === undefined) firstError = error
      }
      record.state = 'closed'
      record.updatedAt = now()
    }
    if (firstError !== undefined) throw mapHarnessError(firstError, 'harness stop failed')
  }

  capabilities(): EngineCapabilities {
    // A1 v2 已通过（2026-10-21，user-role 可注入/system 不可）；契约 7770113 已更新，
    // compaction 事件与稳定 ID 窗口内外可观测，故返回 'available'。
    return {
      manualCompact: false,
      tokenUsage: false,
      mcpTools: true,
      compactionEvents: 'available',
      sessionEnumeration: false,
      crashRecovery: 'structured-error-only',
    }
  }

  async health(): Promise<EngineHealth> {
    const checkedAt = now()
    if (this.status === 'stopped') return { state: 'stopped', checkedAt }
    if (this.status === 'idle') return { state: 'unknown', checkedAt, detail: 'not started' }
    const degraded = [...this.sessions.values()].some((record) => record.state === 'failed')
    return { state: degraded ? 'degraded' : 'ready', checkedAt }
  }

  async createSession(input: CreateSessionInput): Promise<EngineSession> {
    this.ensureRunning()
    if (typeof input?.workingDirectory !== 'string' || input.workingDirectory.trim() === '') {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'createSession requires a non-empty workingDirectory', false, 'INVALID_WORKDIR')
    }
    if (!isDirectory(input.workingDirectory)) {
      throw new HarnessEngineError(
        'ENGINE_PROTOCOL',
        `workingDirectory does not exist or is not a directory: ${input.workingDirectory}`,
        false,
        'WORKDIR_NOT_DIRECTORY',
      )
    }

    const sdk = this.requireSdk()
    const runtimeId = `harness-runtime-${randomUUID()}`
    const dshHome = join(this.options.dshHomeBase, runtimeId)
    let harness: HarnessRuntimeLike | undefined
    try {
      mkdirSync(this.options.dshHomeBase, { recursive: true })
      mkdirSync(dshHome, { recursive: true })
      harness = new sdk.DeepSeekHarness(this.launchOptions(input.workingDirectory, dshHome, []))
      await harness.start()
      const harnessSession = harness.session()
      const actualWorkingDirectory = await harnessSession.setWorkingDirectory(input.workingDirectory)
      const at = now()
      const record: SessionRecord = {
        sessionId: harnessSession.id as SessionId,
        runtimeId,
        workingDirectory: actualWorkingDirectory,
        dshHome,
        harness,
        harnessSession,
        patchPaths: [],
        state: 'ready',
        createdAt: at,
        updatedAt: at,
        ...(input.title === undefined ? {} : { title: input.title }),
      }
      this.sessions.set(record.sessionId, record)
      return new HarnessEngineSession(this, record)
    } catch (error) {
      if (harness !== undefined) {
        try {
          await harness.close()
        } catch {
          // 清理失败不吞掉原始错误；上层可见结构化 create 错误。
        }
      }
      throw mapHarnessError(error, 'harness createSession failed')
    }
  }

  /**
   * 注册表专用：用显式 sessionId/dshHome/patch 启动独立 runtime。
   * patch 缺失或 sessionId 不被 SDK 原样采用时 fail-closed，绝不无身份启动。
   */
  async createSessionWithRuntime(input: HarnessRuntimeCreateInput): Promise<EngineSession> {
    this.ensureRunning()
    if (typeof input?.sessionId !== 'string' || input.sessionId.trim() === '') {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'createSessionWithRuntime requires a non-empty sessionId', false, 'INVALID_SESSION_ID')
    }
    if (typeof input.workingDirectory !== 'string' || input.workingDirectory.trim() === '') {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'createSessionWithRuntime requires a non-empty workingDirectory', false, 'INVALID_WORKDIR')
    }
    if (!isDirectory(input.workingDirectory)) {
      throw new HarnessEngineError(
        'ENGINE_PROTOCOL',
        `workingDirectory does not exist or is not a directory: ${input.workingDirectory}`,
        false,
        'WORKDIR_NOT_DIRECTORY',
      )
    }
    if (typeof input.runtimeId !== 'string' || input.runtimeId.trim() === '' ||
      typeof input.dshHome !== 'string' || input.dshHome.trim() === '') {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'runtimeId and dshHome are required', false, 'INVALID_RUNTIME')
    }
    if (!Array.isArray(input.patchPaths) || input.patchPaths.length === 0) {
      throw new HarnessEngineError(
        'ENGINE_UNAVAILABLE',
        'refusing to start a runtime without a per-session patch (identity fail-closed)',
        false,
        'PATCH_MISSING',
      )
    }
    for (const patchPath of input.patchPaths) {
      if (typeof patchPath !== 'string' || !existsSync(patchPath)) {
        throw new HarnessEngineError(
          'ENGINE_UNAVAILABLE',
          `per-session patch is missing: ${String(patchPath)}`,
          false,
          'PATCH_MISSING',
        )
      }
    }
    if (this.sessions.has(input.sessionId)) {
      throw new HarnessEngineError(
        'ENGINE_PROTOCOL',
        `session ${String(input.sessionId)} already exists in this adapter`,
        false,
        'SESSION_EXISTS',
      )
    }

    const sdk = this.requireSdk()
    let harness: HarnessRuntimeLike | undefined
    try {
      mkdirSync(input.dshHome, { recursive: true })
      harness = new sdk.DeepSeekHarness(
        this.launchOptions(input.workingDirectory, input.dshHome, input.patchPaths),
      )
      await harness.start()
      const harnessSession = harness.session(String(input.sessionId))
      if (harnessSession.id !== String(input.sessionId)) {
        throw new HarnessEngineError(
          'ENGINE_PROTOCOL',
          `harness session id mismatch: requested ${String(input.sessionId)}, got ${harnessSession.id}`,
          false,
          'SESSION_ID_MISMATCH',
        )
      }
      const actualWorkingDirectory = await harnessSession.setWorkingDirectory(input.workingDirectory)
      const at = now()
      const record: SessionRecord = {
        sessionId: harnessSession.id as SessionId,
        runtimeId: input.runtimeId,
        workingDirectory: actualWorkingDirectory,
        dshHome: input.dshHome,
        harness,
        harnessSession,
        patchPaths: [...input.patchPaths],
        state: 'ready',
        createdAt: at,
        updatedAt: at,
        ...(input.title === undefined ? {} : { title: input.title }),
      }
      this.sessions.set(record.sessionId, record)
      return new HarnessEngineSession(this, record)
    } catch (error) {
      if (harness !== undefined) {
        try {
          await harness.close()
        } catch {
          // 保留原始创建错误。
        }
      }
      throw mapHarnessError(error, 'harness createSessionWithRuntime failed')
    }
  }

  /**
   * 只恢复产品自建台账中的会话（N7）。
   * 不存在 → ENGINE_UNAVAILABLE；存在但 runtime 已关闭 → 显式重建同一 dshHome
   * 并调用 SDK resumeSession（持久化历史），不是自动恢复。
   */
  async resumeSession(sessionId: SessionId, input?: ResumeSessionInput): Promise<EngineSession> {
    this.ensureRunning()
    const record = this.requireSession(sessionId, 'SESSION_NOT_IN_LEDGER')
    if (record.state === 'ready') {
      if (input?.workingDirectory !== undefined) await this.setWorkingDirectory(record, input.workingDirectory)
      return new HarnessEngineSession(this, record)
    }
    return this.rebuildRecord(
      record,
      input?.workingDirectory,
      record.patchPaths,
      'harness resumeSession failed',
    )
  }

  /**
   * 注册表专用显式重建：同一 dshHome + 指定（通常是归档后的）patch 调用 SDK resumeSession。
   * 默认强制重建：MCP 子进程崩溃时 record.state 可能仍是 ready，不能据此跳过；
   * force=false 时才允许 ready 早退。重建前由 rebuildRecord 关闭旧 runtime。
   * 不自动重启；仅当上层显式调用时执行。
   */
  async rebuildSession(
    sessionId: SessionId,
    options?: {
      readonly workingDirectory?: string
      readonly patchPaths?: readonly string[]
      readonly force?: boolean
    },
  ): Promise<EngineSession> {
    this.ensureRunning()
    const record = this.requireSession(sessionId, 'SESSION_NOT_IN_LEDGER')
    if (options?.force === false && record.state === 'ready') {
      if (options.workingDirectory !== undefined) await this.setWorkingDirectory(record, options.workingDirectory)
      return new HarnessEngineSession(this, record)
    }
    return this.rebuildRecord(
      record,
      options?.workingDirectory,
      options?.patchPaths ?? record.patchPaths,
      'harness rebuildSession failed',
    )
  }

  /** 注册表状态查询；未知会话返回 undefined，不伪造。 */
  sessionState(sessionId: SessionId): EngineSessionSummary['state'] | undefined {
    return this.sessions.get(sessionId)?.state
  }

  private requireSession(sessionId: SessionId, rawCode: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      throw new HarnessEngineError(
        'ENGINE_UNAVAILABLE',
        `session ${String(sessionId)} not found in product ledger; refusing to fabricate it`,
        false,
        rawCode,
      )
    }
    return record
  }

  private async rebuildRecord(
    record: SessionRecord,
    workingDirectoryInput: string | undefined,
    patchPaths: readonly string[],
    context: string,
  ): Promise<EngineSession> {
    if (workingDirectoryInput !== undefined && !isDirectory(workingDirectoryInput)) {
      throw new HarnessEngineError(
        'ENGINE_PROTOCOL',
        `resume workingDirectory does not exist or is not a directory: ${workingDirectoryInput}`,
        false,
        'WORKDIR_NOT_DIRECTORY',
      )
    }
    for (const patchPath of patchPaths) {
      if (!existsSync(patchPath)) {
        record.state = 'failed'
        record.updatedAt = now()
        throw new HarnessEngineError(
          'ENGINE_UNAVAILABLE',
          `per-session patch is missing: ${patchPath}`,
          false,
          'PATCH_MISSING',
        )
      }
    }

    const sdk = this.requireSdk()
    try {
      await record.harness.close()
    } catch {
      // 旧 runtime 可能已崩溃；继续显式重建，错误由新 resume 暴露。
    }

    const workingDirectory = workingDirectoryInput ?? record.workingDirectory
    let harness: HarnessRuntimeLike | undefined
    try {
      harness = new sdk.DeepSeekHarness(this.launchOptions(workingDirectory, record.dshHome, patchPaths))
      const harnessSession = await harness.resumeSession(String(record.sessionId))
      if (harnessSession.id !== String(record.sessionId)) {
        throw new HarnessEngineError(
          'ENGINE_PROTOCOL',
          `resumed harness session id mismatch: requested ${String(record.sessionId)}, got ${harnessSession.id}`,
          false,
          'SESSION_ID_MISMATCH',
        )
      }
      const actualWorkingDirectory = workingDirectoryInput === undefined
        ? await harnessSession.getWorkingDirectory()
        : await harnessSession.setWorkingDirectory(workingDirectory)
      record.harness = harness
      record.harnessSession = harnessSession
      record.patchPaths = [...patchPaths]
      record.workingDirectory = actualWorkingDirectory
      record.state = 'ready'
      record.updatedAt = now()
      return new HarnessEngineSession(this, record)
    } catch (error) {
      if (harness !== undefined) {
        try {
          await harness.close()
        } catch {
          // 保留原始 resume 错误。
        }
      }
      record.state = 'failed'
      record.updatedAt = now()
      throw mapHarnessError(error, context)
    }
  }

  /** 产品自建台账摘要；不依赖 SDK 枚举。stop 后保留并标记 closed。 */
  async listSessions(): Promise<readonly EngineSessionSummary[]> {
    return [...this.sessions.values()].map((record) => ({
      sessionId: record.sessionId,
      runtimeId: record.runtimeId,
      workingDirectory: record.workingDirectory,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  /** @internal 供 HarnessEngineSession 调用。 */
  sendForSession(record: SessionRecord, prompt: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    this.ensureRunning()
    this.ensureSessionActive(record)
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'send requires a non-empty prompt', false, 'INVALID_PROMPT')
    }
    return this.streamRun(record, prompt, options)
  }

  /** @internal */
  async setWorkingDirectory(record: SessionRecord, path: string): Promise<void> {
    this.ensureRunning()
    this.ensureSessionActive(record)
    if (typeof path !== 'string' || path.trim() === '') {
      throw new HarnessEngineError('ENGINE_PROTOCOL', 'workingDirectory must not be empty', false, 'INVALID_WORKDIR')
    }
    if (!isDirectory(path)) {
      throw new HarnessEngineError(
        'ENGINE_PROTOCOL',
        `workingDirectory does not exist or is not a directory: ${path}`,
        false,
        'WORKDIR_NOT_DIRECTORY',
      )
    }
    try {
      const actual = await record.harnessSession.setWorkingDirectory(path)
      record.workingDirectory = actual
      record.updatedAt = now()
    } catch (error) {
      const mapped = mapHarnessError(error, 'harness setWorkingDirectory failed')
      if (mapped.code === 'TRANSPORT_CLOSED') record.state = 'failed'
      throw mapped
    }
  }

  /** @internal */
  async getWorkingDirectory(record: SessionRecord): Promise<string> {
    this.ensureRunning()
    this.ensureSessionActive(record)
    try {
      const actual = await record.harnessSession.getWorkingDirectory()
      record.workingDirectory = actual
      record.updatedAt = now()
      return actual
    } catch (error) {
      const mapped = mapHarnessError(error, 'harness getWorkingDirectory failed')
      if (mapped.code === 'TRANSPORT_CLOSED') record.state = 'failed'
      throw mapped
    }
  }

  /** @internal */
  async closeSession(record: SessionRecord): Promise<void> {
    if (record.state === 'closed') return
    try {
      await record.harness.close()
      record.state = 'closed'
      record.updatedAt = now()
    } catch (error) {
      throw mapHarnessError(error, 'harness closeSession failed')
    }
  }

  private ensureRunning(): void {
    if (this.status !== 'running') {
      throw new HarnessEngineError(
        'TRANSPORT_CLOSED',
        `harness adapter is ${this.status}; only explicit errors after stop (N6/N15/N16)`,
        false,
        'ADAPTER_NOT_RUNNING',
      )
    }
  }

  private ensureSessionActive(record: SessionRecord): void {
    if (record.state === 'closed') {
      throw new HarnessEngineError('TRANSPORT_CLOSED', 'session is closed; resume or recreate it explicitly', false, 'SESSION_CLOSED')
    }
    if (record.state === 'failed') {
      throw new HarnessEngineError('TRANSPORT_CLOSED', 'session failed; resume explicitly to reactivate it', false, 'SESSION_FAILED')
    }
  }

  private requireSdk(): HarnessSdkModule {
    if (this.sdk === undefined) {
      throw new HarnessEngineError('ENGINE_UNAVAILABLE', 'harness SDK is not loaded; call start() first', false, 'SDK_NOT_LOADED')
    }
    return this.sdk
  }

  private launchOptions(
    workingDirectory: string,
    dshHome: string,
    patchPaths: readonly string[],
  ): HarnessLaunchOptions {
    return {
      cwd: workingDirectory,
      dshHome,
      ...(patchPaths.length === 0 ? {} : { patches: [...patchPaths] }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      provider: this.options.provider ?? 'deepseek-official',
      model: this.options.model ?? 'deepseek-flash',
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }),
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
      initializeTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 180_000,
      ...(this.options.dshBin === undefined ? {} : { dshBin: this.options.dshBin }),
    }
  }

  private async *streamRun(
    record: SessionRecord,
    prompt: string,
    options?: SendOptions,
  ): AsyncGenerator<EngineEvent> {
    if (options?.signal?.aborted) return
    try {
      // 高层 run() 拥有 receipt→idle 的活动区间；harness 无 mid-turn cancel，
      // 因此 abort 只能阻止后续事件产出，无法中断已发出的模型请求。
      const result = await record.harnessSession.run(prompt)
      const mapped = mapHarnessEvents(result.events as readonly HarnessEventLike[], {
        sessionId: record.sessionId,
        fallbackAt: now(),
      })
      for (const diagnostic of mapped.diagnostics) this.logger(diagnostic)

      const events: EngineEvent[] = [...mapped.events]
      const hasComplete = events.some((event) => event.kind === 'message.complete')
      if (!hasComplete && typeof result.finalResponse === 'string' && result.finalResponse.trim().length > 0) {
        const at = now()
        events.push({ kind: 'message.delta', sessionId: record.sessionId, at, text: result.finalResponse })
        events.push({ kind: 'message.complete', sessionId: record.sessionId, at, text: result.finalResponse })
        this.logger({
          kind: 'unmapped-event',
          eventType: '<final-response-fallback>',
          detail: 'RunResult.events 无 message.complete；已用 finalResponse 补齐',
        })
      }
      if (events.length === 0) {
        this.logger({
          kind: 'unmapped-event',
          eventType: '<empty-run>',
          detail: 'run 返回 0 个可映射事件；未伪装成成功',
        })
      }

      for (const event of events) {
        if (options?.signal?.aborted) return
        yield event
      }
      record.updatedAt = now()
    } catch (error) {
      if (options?.signal?.aborted) return
      const mappedError = mapHarnessError(error, 'harness send failed')
      record.state = 'failed'
      record.updatedAt = now()
      yield {
        kind: 'session.error',
        sessionId: record.sessionId,
        at: now(),
        error: mappedError,
      }
    }
  }
}

export { mapHarnessError, mapHarnessEvents } from './mapping.ts'
