/**
 * Host plugin: DF-014 stall watchdog plus the supervisor project goal.
 *
 * Read-only ledger access, Session activity from the live Session or the
 * persisted log, notifications through the official Session prompt channel.
 * No table, column, or Session event type is added.
 * @module @deepseek-ai/dsh-host-governance
 */
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { StallService, activeSupervisor, type PortResult, type StallPorts } from './service.ts'
import {
  type ActivityKind,
  type SessionActivity,
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
}

interface SessionController {
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<unknown>
}

interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

interface SessionLike {
  snapshotEvents(): readonly SessionEventLike[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
  list(): SessionLike[]
}

interface SessionQueryLike {
  readSession(id: string): Promise<{ readonly events: readonly SessionEventLike[] }>
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

interface AgentLike { readonly id: string }
interface AgentsLike { get(id: string): AgentLike | undefined }

interface HostContext {
  readonly tools: { register(definition: unknown): void }
  readonly sessionController: SessionController
  readonly sessions: SessionsLike
  readonly sessionQuery?: SessionQueryLike
  readonly agents: AgentsLike
  readonly goals: GoalsLike
  effect(setup: () => () => void): void
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
      dispatcher_session_id, version, updated_at FROM tasks
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
    }))
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

function lastEvent(events: readonly SessionEventLike[]): SessionEventLike | undefined {
  return events.at(-1)
}

function kindOf(event: SessionEventLike | undefined): ActivityKind | undefined {
  if (event === undefined) return undefined
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') return 'assistant'
  if (event.type === 'tool/call' || event.type === 'tool/result') return 'tool'
  if (event.type === 'user/message') return 'report'
  return undefined
}

/** Whether an unanswered `ask_user_question` call owns the turn (DF-011). */
function waitingQuestion(events: readonly SessionEventLike[]): boolean {
  const results = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const data = event?.data as { callId?: unknown; name?: unknown } | undefined
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    if (event?.type === 'tool/result' && callId !== undefined) { results.add(callId); continue }
    if (event?.type === 'tool/call' && data?.name === 'ask_user_question' && callId !== undefined) {
      return !results.has(callId)
    }
  }
  return false
}

function activityFrom(events: readonly SessionEventLike[]): SessionActivity {
  const event = lastEvent(events)
  return {
    ...(event === undefined ? {} : { lastActivityAt: event.time, kind: kindOf(event) ?? 'assistant' }),
    waitingQuestion: waitingQuestion(events),
  }
}

function safeLog(path: string, message: string): void {
  try {
    appendFileSync(`${path}.plugin.log`, `${new Date().toISOString()} ${message}\n`)
  } catch { /* diagnostics never fail the watchdog */ }
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

  const ports: StallPorts = {
    now: () => Date.now(),
    listProjects: () => ledger.projects(),
    listTasks: projectId => ledger.tasks(projectId),
    lastTaskEventAt: taskId => ledger.lastTaskEventAt(taskId),
    members: projectId => ledger.members(projectId),
    sessionActivity: async (sessionId) => {
      const live = ctx.sessions.get(sessionId)
      if (live !== undefined) return activityFrom(live.snapshotEvents())
      if (ctx.sessionQuery === undefined) throw new Error('sessionQuery unavailable for a cold Session')
      return activityFrom((await ctx.sessionQuery.readSession(sessionId)).events)
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
        content: [{ type: 'text', text: `【升级】任务 ${input.taskId} 已停摆较久且催办无回应，请向用户汇报并请求裁决。` }],
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
    })
  }
}

export { StallService } from './service.ts'
export type { StallConfig, StallTaskView } from './types.ts'
