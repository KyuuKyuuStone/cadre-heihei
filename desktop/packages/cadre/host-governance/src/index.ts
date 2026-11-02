/**
 * Host plugin: DF-014 stall watchdog plus the supervisor project goal.
 *
 * Read-only ledger access, Session activity from the live Session or the
 * persisted log, notifications through the official Session prompt channel.
 * No table, column, or Session event type is added.
 * @module @deepseek-ai/dsh-host-governance
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  CadreEmailNotifier,
  EmailSecretStore,
  dryRunEmail,
  getEmailConfigView,
  loadEmailConfig,
  setEmailConfig,
  testEmail,
} from '@deepseek-ai/dsh-cadre-email-notify'
import { IdleReminderService } from './idle-reminder.ts'
import { ClaimVerifier } from './claims.ts'
import { SessionPresence } from './presence.ts'
import { TokenUsageLedger } from './token-usage.ts'
import { TaskMemoryReader, TaskMemoryCompactionGate, capTaskMemory } from './task-memory.ts'
import { activityFrom, type ActivityEvent } from './activity.ts'
import { StallService, activeSupervisor, type PortResult, type StallPorts } from './service.ts'
import {
  type StallAction,
  type StallActionRequest,
  type StallTaskView,
  type WatchMember,
  type WatchTask,
} from './types.ts'

export interface Config {
  readonly suspectAfterMs?: number
  readonly stalledAfterMs?: number
  readonly recoverAfterMs?: number
  readonly scanIntervalMs?: number
  readonly consecutiveSamples?: number
  readonly nudgeCooldownMs?: number
  readonly escalateAfterMs?: number
  readonly maxGoalRounds?: number
  /** Directory for per-project email JSON configs. */
  readonly emailConfigDir?: string
  /** Feature switch; email sending stays off unless explicitly enabled. */
  readonly emailEnabled?: boolean
  /** Approximate token cap for the automatic task-memory prompt block. */
  readonly taskMemoryTokens?: number
}

interface SessionController {
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<unknown>
}

interface SessionLike {
  snapshotEvents(): readonly ActivityEvent[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
  list(): SessionLike[]
}

interface SessionQueryLike {
  readSession(id: string): Promise<{ readonly events: readonly ActivityEvent[] }>
}

interface GoalViewLike {
  readonly id: string
  readonly revision: number
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly activation: 'armed' | 'disarmed'
}

interface GoalsLike {
  get(agent: unknown): GoalViewLike | undefined
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): GoalViewLike
  resume(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  pause(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  complete(agent: unknown, ref: { id: string; revision: number }): GoalViewLike
  disarm(agent: unknown): GoalViewLike
}

interface AgentLike { readonly id: string; readonly status?: string }
interface AgentsLike { get(id: string): AgentLike | undefined }

interface HostContext {
  readonly tools: { register(definition: unknown): void }
  readonly sessionController: SessionController
  readonly sessions: SessionsLike
  readonly sessionQuery?: SessionQueryLike
  readonly agents: AgentsLike
  readonly goals: GoalsLike
  readonly systemPrompt?: {
    context(section: {
      name: string; order: number; text: (context: { scope?: unknown }) => string; required?: boolean
    }): () => void
  }
  effect(setup: () => () => void): void
  get?(name: string): unknown
  provide?(name: string, value: unknown): void
  on?(event: string, handler: (session: { readonly id: string }, event: unknown) => void): () => void
  inject?(dependencies: readonly string[], callback: (scope: unknown) => void): void
}

export const name = 'host-governance'
export const inject = ['tools', 'sessionController', 'sessions', 'sessionQuery', 'agents', 'goals']

interface Bridge {
  transitionTask(input: {
    databasePath: string; projectId: string; taskId: string; to: string
    actorSessionId: string; idempotencyKey: string; reason?: string
  }): { ok: true; status: string } | { ok: false; code: string; message: string }
  reassignOpenTask?(input: {
    databasePath: string; projectId: string; taskId: string; actorSessionId: string
    toSessionId: string; reason: string; idempotencyKey: string
  }): { ok: true; version: number; replayed: boolean } | { ok: false; code: string; message: string }
}

const requireBridge = createRequire(import.meta.url)
let bridgeCache: Bridge | undefined

function loadBridge(): Bridge {
  if (bridgeCache !== undefined) return bridgeCache
  const candidates = [
    './cadre-ledger.cjs',
    '../../host-collab/lib/cadre-ledger.cjs',
    '../../dsh-host-collab/lib/cadre-ledger.cjs',
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      bridgeCache = requireBridge(candidate) as Bridge
      return bridgeCache
    } catch (error) { lastError = error }
  }
  throw new Error(`host-governance: cadre-ledger.cjs unavailable (${lastError instanceof Error ? lastError.message : String(lastError)})`)
}

/** Minimal read-only view over the cadre SQLite ledger. */
class LedgerReader {
  readonly #db: DatabaseSync
  readonly #path: string

  constructor(path: string) {
    this.#path = path
    this.#db = new DatabaseSync(path, { readOnly: true })
    this.#db.exec('PRAGMA busy_timeout = 5000')
  }

  projects(): string[] {
    return (this.#db.prepare('SELECT DISTINCT project_id FROM tasks').all() as { project_id?: unknown }[])
      .map(row => String(row.project_id))
  }

  tasks(projectId: string): WatchTask[] {
    const rows = this.#db.prepare(`SELECT task_id, project_id, title, status, assignee_session_id,
      dispatcher_session_id, version, updated_at, created_at,
      COALESCE((SELECT MAX(event.at) FROM task_events event
        WHERE event.task_id = tasks.task_id AND event.to_status IN ('dispatched','rework')), tasks.created_at)
        AS window_start
      FROM tasks
      WHERE project_id = ? AND status NOT IN ('verified','failed','cancelled')`).all(projectId) as Record<string, unknown>[]
    return rows.map(row => ({
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      title: String(row.title),
      status: String(row.status),
      assigneeSessionId: String(row.assignee_session_id),
      dispatcherSessionId: String(row.dispatcher_session_id),
      version: Number(row.version ?? 0),
      updatedAt: String(row.updated_at),
      windowStartAt: (() => {
        const parsed = Date.parse(String(row.window_start ?? row.updated_at))
        return Number.isNaN(parsed) ? Date.parse(String(row.updated_at)) : parsed
      })(),
    }))
  }

  /** Newest non-terminal task assigned to one employee, if any. */
  openTask(projectId: string, sessionId: string): { readonly taskId: string; readonly projectId: string } | undefined {
    const row = this.#db.prepare(`SELECT task_id, project_id FROM tasks
      WHERE project_id = ? AND assignee_session_id = ?
        AND status NOT IN ('verified', 'failed', 'cancelled')
      ORDER BY updated_at DESC LIMIT 1`).get(projectId, sessionId) as
      { task_id?: unknown; project_id?: unknown } | undefined
    return typeof row?.task_id === 'string' && typeof row.project_id === 'string'
      ? { taskId: row.task_id, projectId: row.project_id } : undefined
  }

  task(taskId: string): WatchTask | undefined {    const row = this.#db.prepare(`SELECT task_id, project_id, title, status, assignee_session_id,
      dispatcher_session_id, version, updated_at, created_at
      FROM tasks WHERE task_id = ? LIMIT 1`).get(taskId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      title: String(row.title),
      status: String(row.status),
      assigneeSessionId: String(row.assignee_session_id),
      dispatcherSessionId: String(row.dispatcher_session_id),
      version: Number(row.version ?? 0),
      updatedAt: String(row.updated_at),
      windowStartAt: Date.parse(String(row.created_at ?? row.updated_at)) || Date.now(),
    }
  }

  taskStats(projectId: string): { delivered: number; verified: number; failed: number } {
    const rows = this.#db.prepare(
      'SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status',
    ).all(projectId) as { status?: unknown; count?: unknown }[]
    const count = (status: string): number => Number(rows.find(row => row.status === status)?.count ?? 0)
    return { delivered: count('delivered'), verified: count('verified'), failed: count('failed') }
  }

  lastTaskEventAt(taskId: string): number | undefined {
    const row = this.#db.prepare('SELECT MAX(at) AS at FROM task_events WHERE task_id = ?')
      .get(taskId) as { at?: unknown } | undefined
    const value = row?.at
    if (typeof value !== 'string' || value === '') return undefined
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  members(projectId: string): WatchMember[] {
    const rows = this.#db.prepare(`SELECT session_id, role, state,
      COALESCE(NULLIF(TRIM(display_name), ''), session_id) AS name FROM members WHERE project_id = ?`)
      .all(projectId) as Record<string, unknown>[]
    return rows.map(row => ({
      sessionId: String(row.session_id),
      role: String(row.role),
      state: String(row.state),
      displayName: String(row.name),
    }))
  }

  close(): void {
    try { this.#db.close() } catch { /* already closed */ }
  }

  get path(): string { return this.#path }
}

function safeLog(path: string, message: string): void {
  try {
    appendFileSync(`${path}.plugin.log`, `${new Date().toISOString()} ${message}\n`)
  } catch { /* diagnostics never fail the watchdog */ }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Register the watchdog, supervisor tools, loopback action route, and goal lifecycle.
 * @param ctx - Host context with sessions, goals, tools, and the prompt channel.
 * @param config - Optional threshold overrides from the plugin row.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  const databasePath = process.env.CADRE_LEDGER_PATH?.trim()
  if (databasePath === undefined || databasePath === '') {
    console.error('host-governance: CADRE_LEDGER_PATH is unset; stall watchdog is not registered')
    return
  }
  const ledger = new LedgerReader(databasePath)
  const projectOf = (sessionId: string): string | undefined => ledger.projects().find(projectId =>
    ledger.members(projectId).some(member =>
      member.sessionId === sessionId && member.role === 'supervisor' && member.state !== 'departed'))
  const supervisorAgent = (projectId: string): AgentLike | undefined => {
    const member = activeSupervisor(ledger.members(projectId))
    if (member === undefined) return undefined
    return ctx.agents.get(member.sessionId)
  }
  const goalRef = (goal: GoalViewLike): { id: string; revision: number } => ({ id: goal.id, revision: goal.revision })
  const emailConfigDir = config.emailConfigDir
    ?? process.env.CADRE_EMAIL_CONFIG_DIR
    ?? join(homedir(), '.dsh', 'cadre-email')
  const emailSecrets = new EmailSecretStore()
  const emailEnabled = config.emailEnabled === true
  const emailNotifier = new CadreEmailNotifier({ configDir: emailConfigDir, secretStore: emailSecrets, enabled: emailEnabled })
  const captureCurrentWindow = async (): Promise<Buffer | undefined> => {
    try {
      const require = createRequire(import.meta.url)
      const electron = require('electron') as {
        BrowserWindow?: {
          getFocusedWindow?(): { capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer }> } | null
          getAllWindows?(): readonly { isDestroyed?(): boolean; capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer }> }[]
        }
      }
      const windows = electron.BrowserWindow
      if (windows === undefined) return undefined
      const focused = windows.getFocusedWindow?.()
      const win = focused ?? windows.getAllWindows?.().find(candidate => candidate.isDestroyed?.() !== true)
      if (win === undefined || win === null) return undefined
      const image = await win.capturePage()
      return image.isEmpty() ? undefined : image.toPNG()
    } catch (error) {
      console.error(`host-governance: window capture failed: ${String(error)}`)
      return undefined
    }
  }
  const idleReminder = new IdleReminderService({
    isSupervisor: sessionId => projectOf(sessionId) !== undefined,
    projectOf,
    policyOf: projectId => {
      if (!emailEnabled) return undefined
      try {
        const email = loadEmailConfig(emailConfigDir, projectId)
        if (!email.enabled || email.recipients.length === 0) return undefined
        return email.idleReminder
      } catch (error) {
        console.error(`host-governance: idle reminder config failed: ${String(error)}`)
        return undefined
      }
    },
    statsOf: projectId => ledger.taskStats(projectId),
    capture: captureCurrentWindow,
    send: (event, attachments) => emailNotifier.notify(event, attachments),
  })
  const presence = new SessionPresence()
  ctx.provide?.('sessionPresence', presence)
  const tokenUsage = new TokenUsageLedger({
    file: `${databasePath}.token-usage.jsonl`,
    onThreshold: record => {
      appendFileSync(`${databasePath}.plugin.log`, `${JSON.stringify(record)}\n`, 'utf8')
      const compaction = ctx.get?.('compaction') as {
        compactIfNeeded(agent: never, trigger: 'pressure', signal: AbortSignal): Promise<unknown>
      } | undefined
      const agent = ctx.agents.get(record.sessionId)
      if (compaction !== undefined && agent !== undefined) {
        // Automatic compaction at the cross-round threshold; failure only logs
        // and never blocks or asks the user.
        void compaction.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
          .catch((error: unknown) => {
            console.warn(`host-governance: token threshold compaction failed: ${String(error)}`)
          })
      }
    },
  })
  ctx.provide?.('tokenUsage', tokenUsage)
  const taskMemory = new TaskMemoryReader(databasePath)
  ctx.provide?.('taskMemory', taskMemory)
  const memoryCompactionGate = new TaskMemoryCompactionGate()
  const memoryCompaction = ctx.get?.('compaction') as {
    compactNow(agent: never, signal: AbortSignal): Promise<unknown>
  } | undefined
  const disposeMemoryCompaction = ctx.on === undefined
    ? undefined
    : ctx.on('agent/status', ((payload: { readonly agent: { readonly id: string; readonly status?: string }; readonly status: string }) => {
      const projectId = projectOf(payload.agent.id)
      if (projectId === undefined || memoryCompaction === undefined) return
      const latest = taskMemory.latest(projectId)
      if (!memoryCompactionGate.shouldCompact(payload.agent.id, latest, payload.status) || latest === undefined) return
      const agent = ctx.agents.get(payload.agent.id)
      if (agent === undefined) return
      // A completed task's archive is the trigger: force one compaction so the
      // task's original messages leave the next request. Failures stay visible
      // and do not mark the gate, so a later idle event retries.
      void memoryCompaction.compactNow(agent as never, new AbortController().signal)
        .then(() => { memoryCompactionGate.markCompacted(payload.agent.id, latest.updatedAt) })
        .catch((error: unknown) => {
          console.warn(`host-governance: completed-task compaction failed: ${String(error)}`)
        })
    }) as never)
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    if (ctx.systemPrompt !== undefined) {
      disposers.push(ctx.systemPrompt.context({
        name: 'cadre/task-memory', order: 850,
        text: context => {
          const agent = context.scope as { session?: { id?: unknown } } | undefined
          const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : undefined
          if (sessionId === undefined) return ''
          const projectId = projectOf(sessionId)
          if (projectId === undefined) return ''
          try {
            const memory = taskMemory.context({ projectId, actorSessionId: sessionId })
            return capTaskMemory(memory.rendered, config.taskMemoryTokens ?? 2_000)
          } catch {
            return ''
          }
        },
      }))
    }
    return () => { for (const dispose of disposers) dispose() }
  })
  const disposeIdleEvents = ctx.on === undefined
    ? undefined
    : ctx.on('session/event', (session, event) => {
      const typed = event as { type?: unknown; data?: unknown }
      if (typed.type === 'user/message') presence.mark(session.id, false)
      if (typed.type === 'assistant/message' && typeof typed.data === 'object' && typed.data !== null) {
        const data = typed.data as { turn?: unknown; usage?: Record<string, unknown> }
        if (data.usage !== undefined) {
          const projectId = projectOf(session.id)
          const task = projectId === undefined ? undefined : ledger.openTask(projectId, session.id)
          if (projectId !== undefined) {
            tokenUsage.ingest({
              projectId, sessionId: session.id,
              ...(task === undefined ? {} : { taskId: task.taskId }),
              round: typeof data.turn === 'number' ? data.turn : 1,
              usage: {
                inputTokens: numberOrZero(data.usage.inputTokens),
                outputTokens: numberOrZero(data.usage.outputTokens),
                totalTokens: numberOrZero(data.usage.totalTokens),
                cacheReadTokens: numberOrZero(data.usage.cacheReadTokens),
                cacheWriteTokens: numberOrZero(data.usage.cacheWriteTokens),
              },
            })
          }
        }
      }
      idleReminder.handle(session.id, event as { type?: unknown; data?: unknown })
    })
  const claims = new ClaimVerifier({
    projectOf,
    ledger: {
      task: taskId => ledger.task(taskId),
      members: projectId => ledger.members(projectId),
    },
    appendAudit: record => {
      appendFileSync(`${databasePath}.plugin.log`, `${JSON.stringify(record)}\n`, 'utf8')
    },
  })
  const disposeClaimEvents = ctx.on === undefined
    ? undefined
    : ctx.on('session/event', (session, event) => {
      claims.handle(session.id, event as { type?: unknown; seq?: unknown; data?: unknown })
    })
  ctx.effect(() => () => {
    disposeIdleEvents?.()
    disposeClaimEvents?.()
    disposeMemoryCompaction?.()
    idleReminder.dispose()
    claims.dispose()
    presence.dispose()
    taskMemory.close()
  })

  const ports: StallPorts = {
    now: () => Date.now(),
    email: event => emailNotifier.notify(event),
    listProjects: () => ledger.projects(),
    listTasks: projectId => ledger.tasks(projectId),
    lastTaskEventAt: taskId => ledger.lastTaskEventAt(taskId),
    members: projectId => ledger.members(projectId),
    sessionActivity: async (sessionId, windowStartAt) => {
      const live = ctx.sessions.get(sessionId)
      if (live !== undefined) return activityFrom(live.snapshotEvents(), windowStartAt)
      if (ctx.sessionQuery === undefined) throw new Error('sessionQuery unavailable for a cold Session')
      return activityFrom((await ctx.sessionQuery.readSession(sessionId)).events, windowStartAt)
    },
    prompt: async (sessionId, text) => {
      await ctx.sessionController.prompt({
        requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }],
      }, AbortSignal.timeout(60_000))
    },
    cancelTask: async (input): Promise<PortResult> => {
      try {
        const outcome = loadBridge().transitionTask({
          databasePath, projectId: input.projectId, taskId: input.taskId, to: 'cancelled',
          actorSessionId: input.actorSessionId,
          idempotencyKey: `stall-cancel:${input.taskId}:${randomUUID()}`,
          reason: input.reason,
        })
        return outcome.ok ? { ok: true } : outcome
      } catch (error) {
        return { ok: false, code: 'CANCEL_NOT_ALLOWED', message: error instanceof Error ? error.message : String(error) }
      }
    },
    reassignTask: async (input): Promise<PortResult> => {
      try {
        const bridge = loadBridge()
        if (bridge.reassignOpenTask === undefined) {
          return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: 'cadre-ledger.cjs 缺少 reassignOpenTask（请重建）' }
        }
        const outcome = bridge.reassignOpenTask({
          databasePath, projectId: input.projectId, taskId: input.taskId,
          actorSessionId: input.actorSessionId, toSessionId: input.toSessionId,
          reason: input.reason, idempotencyKey: randomUUID(),
        })
        return outcome.ok ? { ok: true } : outcome
      } catch (error) {
        return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: error instanceof Error ? error.message : String(error) }
      }
    },
    escalate: async (input): Promise<PortResult> => {
      const supervisor = activeSupervisor(ledger.members(input.projectId))
      if (supervisor === undefined) return { ok: false, code: 'ESCALATE_FAILED', message: '本项目没有在册 supervisor' }
      await ctx.sessionController.prompt({
        requestId: randomUUID(), sessionId: supervisor.sessionId, mode: 'queue',
        content: [{ type: 'text', text: `【需要您决定】任务 ${input.taskId} 已停摆较久且催办无回应，请向用户汇报并请求裁决。` }],
      }, AbortSignal.timeout(60_000))
      return { ok: true }
    },
    goal: (projectId) => {
      try {
        const agent = supervisorAgent(projectId)
        if (agent === undefined) return undefined
        const goal = ctx.goals.get(agent)
        return goal === undefined ? undefined : { id: goal.id, revision: goal.revision, phase: goal.phase, activation: goal.activation }
      } catch (error) {
        safeLog(ledger.path, `goal read failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
    createGoal: (projectId, objective, maxGoalRounds) => {
      const agent = supervisorAgent(projectId)
      if (agent === undefined) return false
      try {
        const goal = ctx.goals.create(agent, { objective, maxGoalRounds })
        void goal
        return true
      } catch (error) {
        safeLog(ledger.path, `goal create failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    resumeGoal: (projectId) => {
      const agent = supervisorAgent(projectId)
      const goal = agent === undefined ? undefined : ctx.goals.get(agent)
      if (agent === undefined || goal === undefined || goal.phase !== 'paused') return
      try { ctx.goals.resume(agent, goalRef(goal)) } catch (error) {
        safeLog(ledger.path, `goal resume failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
      }
    },
    pauseGoal: (projectId) => {
      const agent = supervisorAgent(projectId)
      const goal = agent === undefined ? undefined : ctx.goals.get(agent)
      if (agent === undefined || goal === undefined || goal.phase !== 'active') return
      try { ctx.goals.pause(agent, goalRef(goal)) } catch (error) {
        safeLog(ledger.path, `goal pause failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
      }
    },
    completeGoal: (projectId) => {
      const agent = supervisorAgent(projectId)
      const goal = agent === undefined ? undefined : ctx.goals.get(agent)
      if (agent === undefined || goal === undefined || goal.phase === 'complete') return
      try { ctx.goals.complete(agent, goalRef(goal)) } catch (error) {
        safeLog(ledger.path, `goal complete failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
      }
    },
    disarmGoal: (projectId) => {
      const agent = supervisorAgent(projectId)
      if (agent === undefined) return
      try { ctx.goals.disarm(agent) } catch (error) {
        safeLog(ledger.path, `goal disarm failed project=${projectId} reason=${error instanceof Error ? error.message : String(error)}`)
      }
    },
    log: message => safeLog(ledger.path, message),
  }

  const service = new StallService(ports, config)
  const projects = new Set(ledger.projects())
  const scan = async (): Promise<void> => {
    try {
      await service.scan()
    } catch (error) {
      safeLog(ledger.path, `scan failed reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void scan()
  const timer = setInterval(() => { void scan() }, service.config.scanIntervalMs)
  timer.unref?.()
  const dispose = (): void => {
    clearInterval(timer)
    for (const projectId of projects) ports.disarmGoal(projectId)
    ledger.close()
  }
  ctx.effect(() => dispose)

  const callerOf = (run: { readonly agent?: { readonly id: string } }): string => {
    const id = run.agent?.id
    if (id === undefined) throw new Error('host-governance: 工具必须由会话内的 Agent 调用')
    return id
  }
  const actionTool = (toolName: string, action: StallAction, label: string): void => {
    ctx.tools.register({
      name: toolName,
      description: `${label}（仅本项目 supervisor；停摆任务处置，version 用 stall 视图里的值）。`,
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['taskId', 'episodeId', 'expectedVersion'],
        properties: {
          taskId: { type: 'string' },
          episodeId: { type: 'string' },
          expectedVersion: { type: 'integer' },
          reason: { type: 'string' },
          ...(action === 'reassign' ? { toSessionId: { type: 'string' } } : {}),
          idempotencyKey: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false, required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            message: { type: 'string' },
            version: { type: 'integer' },
            action: { type: 'string' },
            replayed: { type: 'boolean' },
          },
        },
        render: (_args: unknown, value: { ok: boolean; code?: string; message?: string }) => [{
          type: 'text', text: value.ok ? `${label}成功` : `${label}失败：${value.code ?? ''} ${value.message ?? ''}`.trim(),
        }],
      },
      isConcurrencySafe: () => false,
      execute: async (args: Record<string, unknown>, run: { agent?: { id: string } }) => {
        const actor = callerOf(run)
        const projectId = projectOf(actor)
        if (projectId === undefined) throw new Error('FORBIDDEN_ACTOR: 只有本项目在册 supervisor 可以处置停摆任务')
        const request: StallActionRequest = {
          action,
          projectId,
          taskId: String(args.taskId),
          episodeId: String(args.episodeId),
          expectedVersion: Number(args.expectedVersion),
          actorSessionId: actor,
          idempotencyKey: typeof args.idempotencyKey === 'string' && args.idempotencyKey !== ''
            ? args.idempotencyKey
            : randomUUID(),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
          ...(typeof args.toSessionId === 'string' ? { toSessionId: args.toSessionId } : {}),
        }
        return service.act(request)
      },
    })
  }
  actionTool('nudge_task', 'nudge', '催办停摆任务')
  actionTool('reassign_task', 'reassign', '重派停摆任务')
  actionTool('cancel_task', 'cancel', '取消停摆任务')
  actionTool('escalate_stall', 'escalate', '升级停摆任务')

  ctx.tools.register({
    name: 'list_stalled_tasks',
    description: 'List stall views for the caller\'s project (supervisor only).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['tasks'],
        properties: { tasks: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render: (_args: unknown, value: { tasks: readonly StallTaskView[] }) => [{
        type: 'text', text: value.tasks.length === 0 ? '当前没有停摆任务。'
          : value.tasks.map(task => `${task.taskId} [${task.stallState}] ${task.title} · ${task.assigneeName}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    execute: async (_args: unknown, run: { agent?: { id: string } }) => {
      const actor = callerOf(run)
      const found = projectOf(actor)
      if (found === undefined) throw new Error('FORBIDDEN_ACTOR: 只有本项目在册 supervisor 可以查看停摆任务')
      return { tasks: service.snapshot(found) }
    },
  })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scope) => {
      const web = scope as {
        webServer: { register(route: {
          kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
        }): () => void }
        connection: { admit(req: IncomingMessage): { readonly rejection: number } | unknown }
        effect(setup: () => () => void, label: string): () => void
      }
      const reply = (res: ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const readBody = async (req: IncomingMessage): Promise<unknown> => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
          size += buffer.length
          if (size > 16_384) throw new Error('请求体过大')
          chunks.push(buffer)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/stall/action',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            const action = body.action
            if (action !== 'nudge' && action !== 'reassign' && action !== 'cancel' && action !== 'escalate') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'action 必须是 nudge/reassign/cancel/escalate' })
            }
            if (typeof body.projectId !== 'string' || typeof body.taskId !== 'string'
              || typeof body.episodeId !== 'string' || typeof body.actorSessionId !== 'string') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/taskId/episodeId/actorSessionId 必填' })
            }
            const request: StallActionRequest = {
              action: action as StallAction,
              projectId: body.projectId,
              taskId: body.taskId,
              episodeId: body.episodeId,
              expectedVersion: Number(body.expectedVersion),
              actorSessionId: body.actorSessionId,
              idempotencyKey: typeof body.idempotencyKey === 'string' && body.idempotencyKey !== ''
                ? body.idempotencyKey : randomUUID(),
              ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
              ...(typeof body.toSessionId === 'string' ? { toSessionId: body.toSessionId } : {}),
            }
            const result = await service.act(request)
            reply(res, result.ok ? 200 : 409, result)
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/stall/action')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/stall/snapshot',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            if (typeof body.projectId !== 'string' || typeof body.actorSessionId !== 'string') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/actorSessionId 必填' })
            }
            if (projectOf(body.actorSessionId) !== body.projectId) {
              return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目在册 supervisor 可以查看停摆视图' })
            }
            const config = service.config
            reply(res, 200, {
              tasks: service.snapshot(body.projectId),
              thresholds: {
                suspectAfterMs: config.suspectAfterMs,
                stalledAfterMs: config.stalledAfterMs,
                recoverAfterMs: config.recoverAfterMs,
                scanIntervalMs: config.scanIntervalMs,
                consecutiveSamples: config.consecutiveSamples,
                nudgeCooldownMs: config.nudgeCooldownMs,
                escalateAfterMs: config.escalateAfterMs,
              },
            })
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/stall/snapshot')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/claims/snapshot',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            if (typeof body.projectId !== 'string' || typeof body.actorSessionId !== 'string') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/actorSessionId 必填' })
            }
            if (projectOf(body.actorSessionId) !== body.projectId) {
              return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目在册 supervisor 可以查看派活核实' })
            }
            reply(res, 200, { claims: claims.snapshot(body.projectId) })
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/claims/snapshot')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/session/typing',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.typing !== 'boolean') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'sessionId/typing 必填' })
            }
            reply(res, 200, { ok: true, ...presence.mark(body.sessionId, body.typing) })
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/session/typing')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/token/snapshot',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            if (typeof body.projectId !== 'string' || typeof body.actorSessionId !== 'string') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/actorSessionId 必填' })
            }
            if (projectOf(body.actorSessionId) !== body.projectId) {
              return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目成员可以查看 token 用量' })
            }
            if (typeof body.taskId === 'string') {
              const task = ledger.task(body.taskId)
              if (task === undefined || task.projectId !== body.projectId) {
                return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '任务不属于本项目' })
              }
              return reply(res, 200, { ok: true, snapshot: tokenUsage.snapshot({ taskId: body.taskId }) })
            }
            if (typeof body.sessionId === 'string') {
              if (projectOf(body.sessionId) !== body.projectId) {
                return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '会话不属于本项目' })
              }
              return reply(res, 200, { ok: true, snapshot: tokenUsage.snapshot({ sessionId: body.sessionId }) })
            }
            return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'taskId/sessionId 至少一个' })
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/token/snapshot')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/task-memory',
        handler: async (req, res) => {
          if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
          }
          try {
            const body = await readBody(req) as Record<string, unknown>
            if (typeof body.projectId !== 'string' || typeof body.actorSessionId !== 'string'
              || (body.mode !== 'context' && body.mode !== 'search')) {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/actorSessionId/mode 必填' })
            }
            if (projectOf(body.actorSessionId) !== body.projectId) {
              return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目成员可以查看任务记忆' })
            }
            if (body.mode === 'context') {
              return reply(res, 200, {
                ok: true,
                ...taskMemory.context({
                  projectId: body.projectId, actorSessionId: body.actorSessionId,
                  ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
                }),
              })
            }
            if (typeof body.query !== 'string' || body.query.trim() === '') {
              return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'search 需要 query' })
            }
            return reply(res, 200, {
              ok: true,
              memories: taskMemory.search({
                projectId: body.projectId, actorSessionId: body.actorSessionId, query: body.query,
                includeSnippet: body.includeSnippet === true,
              }),
            })
          } catch (error) {
            reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'host-governance: /cadre/task-memory')

      const emailRoute = (
        path: string,
        method: 'getConfig' | 'setConfig' | 'testSend' | 'dryRun' | 'setSecret',
        operation: (projectId: string, body: Record<string, unknown>) => Promise<unknown> | unknown,
      ): void => {
        web.effect(() => web.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
            const admission = web.connection.admit(req)
            if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
              return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
            }
            try {
              const body = await readBody(req) as Record<string, unknown>
              if (typeof body.projectId !== 'string' || typeof body.actorSessionId !== 'string') {
                return reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId/actorSessionId 必填' })
              }
              if (projectOf(body.actorSessionId) !== body.projectId) {
                return reply(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目在册 supervisor 可以配置邮件通知' })
              }
              reply(res, 200, { ok: true, method, result: await operation(body.projectId, body) })
            } catch (error) {
              if ((error as { code?: unknown }).code === 'SECRET_STORE_UNAVAILABLE') {
                return reply(res, 503, { ok: false, code: 'SECRET_STORE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) })
              }
              reply(res, 400, { ok: false, code: 'EMAIL_CONFIG_INVALID', message: error instanceof Error ? error.message : String(error) })
            }
          },
        }), `host-governance: ${path}`)
      }

      emailRoute('/cadre/email/get', 'getConfig', projectId => getEmailConfigView(emailConfigDir, projectId, process.env, emailSecrets))
      emailRoute('/cadre/email/set', 'setConfig', (projectId, body) => {
        if (typeof body.config !== 'object' || body.config === null) {
          throw new Error('EMAIL_CONFIG_INVALID: config must be an object')
        }
        return setEmailConfig(emailConfigDir, projectId, body.config)
      })
      emailRoute('/cadre/email/test', 'testSend', projectId => testEmail(emailNotifier, projectId))
      emailRoute('/cadre/email/dry-run', 'dryRun', projectId => dryRunEmail(emailNotifier, projectId))
      emailRoute('/cadre/email/secret', 'setSecret', async (projectId, body) => {
        if (body.action === 'clear') {
          emailSecrets.clear(projectId)
          return { hasKey: false }
        }
        if (typeof body.authCode !== 'string' || body.authCode.trim() === '') {
          throw new Error('EMAIL_SECRET_EMPTY: authCode 必填')
        }
        await emailSecrets.set(projectId, body.authCode)
        return { hasKey: emailSecrets.has(projectId) }
      })
    })
  }
}

export { StallService } from './service.ts'
export type { StallConfig, StallTaskView } from './types.ts'
