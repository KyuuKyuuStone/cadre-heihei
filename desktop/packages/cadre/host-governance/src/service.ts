/**
 * Pure orchestration for the DF-014 watchdog and its supervisor actions.
 *
 * Ports own IO so the state machine, goal lifecycle, and permission checks are
 * testable without Cordis, Electron, or a real ledger.
 */
import {
  DEFAULT_STALL_CONFIG,
  STALLABLE_STATUSES,
  type ActivityKind,
  type GoalState,
  type SessionActivity,
  type StallActionResult,
  type StallActionRequest,
  type StallConfig,
  type StallState,
  type StallTaskView,
  type WatchMember,
  type WatchTask,
} from './types.ts'

/** Successful or structured-failure result of one ledger/notification operation. */
export type PortResult = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }

/** IO the watchdog needs. Every failure must be surfaced, never silently treated as normal. */
export interface StallPorts {
  now(): number
  listProjects(): readonly string[]
  /** Non-terminal tasks: the four stallable statuses plus delivered/review. */
  listTasks(projectId: string): readonly WatchTask[]
  lastTaskEventAt(taskId: string): number | undefined
  sessionActivity(sessionId: string, windowStartAt: number): Promise<SessionActivity>
  members(projectId: string): readonly WatchMember[]
  prompt(sessionId: string, text: string): Promise<void>
  cancelTask(input: { projectId: string; taskId: string; actorSessionId: string; reason: string }): Promise<PortResult>
  reassignTask(input: {
    projectId: string
    taskId: string
    actorSessionId: string
    toSessionId: string
    reason: string
  }): Promise<PortResult>
  escalate(input: { projectId: string; taskId: string; actorSessionId: string }): Promise<PortResult>
  goal(projectId: string): GoalState | undefined
  createGoal(projectId: string, objective: string, maxGoalRounds: number): boolean
  resumeGoal(projectId: string): void
  pauseGoal(projectId: string): void
  completeGoal(projectId: string): void
  disarmGoal(projectId: string): void
  log(message: string): void
}

interface Episode {
  task: WatchTask
  lastActivityAt: number | undefined
  kind: ActivityKind | undefined
  stale: boolean
  waitingQuestion: boolean
  silenceStreak: number
  state: StallState | 'waiting_question'
  stateSince: number
  episodeId: string
  nudgeCount: number
  lastNudgedAt: number | undefined
  escalated: boolean
  notifiedState: StallState | 'waiting_question' | undefined
  /** First normal sample after activity; the episode only recovers once this window completes. */
  recoveringSince: number | undefined
}

/** Owner supervisor for a project's stall notifications and actions. */
export function activeSupervisor(members: readonly WatchMember[]): WatchMember | undefined {
  return members.find(member =>
    member.role === 'supervisor' && member.state !== 'departed' && member.sessionId !== 'sup-1')
}

function levelFor(silenceMs: number, config: StallConfig): StallState {
  if (silenceMs >= config.stalledAfterMs) return 'stalled'
  if (silenceMs >= config.suspectAfterMs) return 'possibly_stalled'
  return 'normal'
}

function durationText(ms: number): string {
  return `${String(Math.max(1, Math.round(ms / 60_000)))} 分钟`
}

function notificationText(view: StallTaskView, kind: 'stalled' | 'possibly_stalled' | 'recovered' | 'escalated'): string {
  if (kind === 'recovered') {
    return `【已恢复活动】任务 ${view.taskId}「${view.title}」的员工重新开始活动，停摆提示解除。`
  }
  if (kind === 'escalated') {
    return `【升级】任务 ${view.taskId}「${view.title}」已停摆 ${durationText(view.silenceMs ?? 0)}，已催办 ${String(view.nudgeCount)} 次仍无回应，请用户裁决。`
  }
  const label = kind === 'stalled' ? '已停摆' : '可能停摆'
  return [
    `【${label}】任务 ${view.taskId}「${view.title}」`,
    `员工：${view.assigneeName}（${view.assigneeSessionId}）`,
    `最后活动：${view.lastActivityAt === null ? '未知' : new Date(view.lastActivityAt).toISOString()}（${String(view.lastActivityKind ?? 'status')}）`,
    `无活动：${durationText(view.silenceMs ?? 0)}`,
    `episodeId：${view.episodeId}`,
    '建议：先催办；连续催办无回应可重派或取消，必要时升级给用户。',
  ].join('\n')
}

function viewOf(episode: Episode, member: WatchMember | undefined, now: number): StallTaskView {
  const silence = episode.lastActivityAt === undefined ? null : Math.max(0, now - episode.lastActivityAt)
  const stallable = (STALLABLE_STATUSES as readonly string[]).includes(episode.task.status)
  const state = stallable ? episode.state : 'normal'
  const actionable = state === 'stalled' && !episode.stale
  return {
    taskId: episode.task.taskId,
    title: episode.task.title,
    taskStatus: episode.task.status,
    assigneeSessionId: episode.task.assigneeSessionId,
    assigneeName: member?.displayName ?? episode.task.assigneeSessionId,
    assigneeRole: member?.role ?? 'worker',
    lastActivityAt: episode.lastActivityAt ?? null,
    lastActivityKind: episode.kind ?? null,
    silenceMs: silence,
    stallState: state,
    stateSince: episode.stateSince,
    episodeId: episode.episodeId,
    nudgeCount: episode.nudgeCount,
    lastNudgedAt: episode.lastNudgedAt ?? null,
    suggestedAction: actionable ? (episode.nudgeCount === 0 ? 'nudge' : 'escalate') : null,
    capabilities: { nudge: actionable, reassign: actionable, cancel: actionable, escalate: actionable },
    version: episode.task.version,
    stale: episode.stale || episode.lastActivityAt === undefined,
    updatedAt: episode.task.updatedAt,
  }
}

/** Watchdog state machine plus action/goal orchestration. */
export class StallService {
  readonly #ports: StallPorts
  readonly #config: StallConfig
  readonly #episodes = new Map<string, Episode>()
  readonly #actionResults = new Map<string, { readonly fingerprint: string; readonly result: StallActionResult }>()
  readonly #lastViews = new Map<string, StallTaskView>()

  constructor(ports: StallPorts, config: Partial<StallConfig> = {}) {
    this.#ports = ports
    this.#config = { ...DEFAULT_STALL_CONFIG, ...config }
  }

  /** Current thresholds (the Host view serves these to the Client). */
  get config(): StallConfig {
    return this.#config
  }

  /** Every task view known from the latest scan. */
  views(): readonly StallTaskView[] {
    return [...this.#lastViews.values()]
  }

  /** One project's task views. */
  snapshot(projectId: string): readonly StallTaskView[] {
    return this.views().filter(view => this.#episodes.get(this.key(projectId, view.taskId)) !== undefined)
  }

  private key(projectId: string, taskId: string): string {
    return `${projectId}\u0000${taskId}`
  }

  private episodeFor(task: WatchTask, now: number): Episode {
    const key = this.key(task.projectId, task.taskId)
    const existing = this.#episodes.get(key)
    if (existing !== undefined) {
      // External status/version writes must be visible to the next view read.
      existing.task = task
      return existing
    }
    const created: Episode = {
      task,
      lastActivityAt: undefined,
      kind: undefined,
      stale: true,
      waitingQuestion: false,
      silenceStreak: 0,
      state: 'normal',
      stateSince: now,
      episodeId: `${task.taskId}:${new Date(now).toISOString()}`,
      nudgeCount: 0,
      lastNudgedAt: undefined,
      escalated: false,
      notifiedState: undefined,
      recoveringSince: undefined,
    }
    this.#episodes.set(key, created)
    return created
  }

  private async notify(projectId: string, view: StallTaskView, kind: 'stalled' | 'possibly_stalled' | 'recovered' | 'escalated'): Promise<void> {
    const supervisor = activeSupervisor(this.#ports.members(projectId))
    if (supervisor === undefined) {
      this.#ports.log(`stall notify skipped project=${projectId} task=${view.taskId} reason=no-supervisor kind=${kind}`)
      return
    }
    try {
      await this.#ports.prompt(supervisor.sessionId, notificationText(view, kind))
    } catch (error) {
      this.#ports.log(`stall notify failed project=${projectId} task=${view.taskId} kind=${kind} reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One watchdog pass. Never throws: every per-task failure is logged and the
   * view is marked stale instead of being silently reported as normal.
   * @returns the views produced by this pass.
   */
  async scan(): Promise<readonly StallTaskView[]> {
    const now = this.#ports.now()
    const seen = new Set<string>()
    for (const projectId of this.#ports.listProjects()) {
      const members = this.#ports.members(projectId)
      const tasks = this.#ports.listTasks(projectId)
      for (const task of tasks) {
        const key = this.key(projectId, task.taskId)
        seen.add(key)
        const episode = this.episodeFor(task, now)
        const previousActivityAt = episode.lastActivityAt
        const stallable = (STALLABLE_STATUSES as readonly string[]).includes(task.status)
        let activity: SessionActivity = { waitingQuestion: false }
        try {
          activity = await this.#ports.sessionActivity(task.assigneeSessionId, task.windowStartAt)
        } catch (error) {
          episode.stale = true
          this.#ports.log(`stall activity unavailable task=${task.taskId} reason=${error instanceof Error ? error.message : String(error)}`)
        }
        const taskEvent = this.#ports.lastTaskEventAt(task.taskId)
        const candidates = [activity.lastActivityAt, taskEvent].filter((value): value is number => value !== undefined)
        const last = candidates.length === 0 ? undefined : Math.max(...candidates)
        episode.stale = last === undefined
        if (last !== undefined) {
          episode.lastActivityAt = last
          episode.kind = activity.lastActivityAt !== undefined && (taskEvent === undefined || activity.lastActivityAt >= taskEvent)
            ? (activity.kind ?? 'assistant')
            : 'status'
        }
        episode.waitingQuestion = activity.waitingQuestion

        if (!stallable) {
          if (episode.state !== 'normal') {
            episode.state = 'normal'
            episode.stateSince = now
            episode.silenceStreak = 0
          }
          episode.recoveringSince = undefined
          const view = viewOf(episode, members.find(member => member.sessionId === task.assigneeSessionId), now)
          this.#lastViews.set(key, view)
          continue
        }

        const activityChanged = last !== undefined
          && (previousActivityAt === undefined || last > previousActivityAt)
        const previouslyStalled = episode.state === 'stalled' || episode.state === 'possibly_stalled'
        const member = members.find(candidate => candidate.sessionId === task.assigneeSessionId)
        const notifyState = async (next: 'possibly_stalled' | 'stalled'): Promise<void> => {
          episode.state = next
          episode.stateSince = now
          episode.notifiedState = next
          await this.notify(projectId, viewOf(episode, member, now), next)
        }

        if (activity.waitingQuestion) {
          episode.silenceStreak = 0
          episode.recoveringSince = undefined
          if (episode.state !== 'waiting_question') {
            episode.state = 'waiting_question'
            episode.stateSince = now
          }
        } else if (last === undefined) {
          // No activity source: keep the previous state (never silently call it normal)
          // and let stale=true disable actions in the view.
          episode.silenceStreak = 0
          episode.recoveringSince = undefined
        } else {
          const silence = Math.max(0, now - last)
          const level = levelFor(silence, this.#config)
          if (level === 'normal') {
            episode.silenceStreak = 0
            if (previouslyStalled) {
              // Recovery needs new activity that stays normal for recoverAfterMs.
              if (episode.recoveringSince === undefined && activityChanged) episode.recoveringSince = now
              if (episode.recoveringSince !== undefined
                && now - episode.recoveringSince >= this.#config.recoverAfterMs) {
                const recovered = viewOf({ ...episode, state: 'normal' }, member, now)
                await this.notify(projectId, recovered, 'recovered')
                episode.episodeId = `${task.taskId}:${new Date(now).toISOString()}`
                episode.state = 'normal'
                episode.stateSince = now
                episode.silenceStreak = 0
                episode.nudgeCount = 0
                episode.lastNudgedAt = undefined
                episode.escalated = false
                episode.notifiedState = undefined
                episode.recoveringSince = undefined
              }
              // Before the window completes the previous warning stays visible.
            }
          } else {
            episode.recoveringSince = undefined
            episode.silenceStreak += 1
            const effective = episode.silenceStreak >= this.#config.consecutiveSamples ? level : 'normal'
            if (previouslyStalled) {
              // Never downgrade an existing warning because the measured silence shrank.
              if (episode.state === 'possibly_stalled' && effective === 'stalled') await notifyState('stalled')
            } else if (effective !== 'normal') {
              await notifyState(effective)
            }
          }
        }

        const view = viewOf(episode, members.find(member => member.sessionId === task.assigneeSessionId), now)
        this.#lastViews.set(key, view)

        if (episode.state === 'stalled' && episode.recoveringSince === undefined && episode.nudgeCount >= 1
          && !episode.escalated && now - episode.stateSince >= this.#config.escalateAfterMs) {
          const escalated = await this.#ports.escalate({
            projectId, taskId: task.taskId, actorSessionId: this.supervisorId(projectId) ?? '',
          })
          if (escalated.ok) {
            episode.escalated = true
          } else {
            this.#ports.log(`stall escalate failed project=${projectId} task=${task.taskId} code=${escalated.code}`)
          }
        }
      }
      await this.reconcileGoal(projectId, tasks, now)
    }
    for (const key of this.#episodes.keys()) {
      if (!seen.has(key)) this.#episodes.delete(key)
    }
    for (const key of this.#lastViews.keys()) {
      if (!seen.has(key)) this.#lastViews.delete(key)
    }
    return this.views()
  }

  private async reconcileGoal(projectId: string, tasks: readonly WatchTask[], now: number): Promise<void> {
    const goal = this.#ports.goal(projectId)
    const supervisor = activeSupervisor(this.#ports.members(projectId))
    if (tasks.length === 0) {
      if (goal !== undefined && goal.phase !== 'complete') {
        this.#ports.completeGoal(projectId)
        this.#ports.log(`goal complete project=${projectId} reason=no-open-task at=${String(now)}`)
      }
      return
    }
    const stallable = tasks.filter(task => (STALLABLE_STATUSES as readonly string[]).includes(task.status))
    if (stallable.length === 0) {
      if (goal?.phase === 'active') this.#ports.pauseGoal(projectId)
      return
    }
    const awaitingQuestion = stallable.some(task => this.#episodes.get(this.key(projectId, task.taskId))?.state === 'waiting_question')
    if (awaitingQuestion) {
      if (goal?.phase === 'active') {
        this.#ports.pauseGoal(projectId)
        this.#ports.log(`goal pause project=${projectId} reason=waiting-question`)
      }
      return
    }
    const stalled = stallable.some(task => this.#episodes.get(this.key(projectId, task.taskId))?.state === 'stalled')
    if (!stalled) return
    if (supervisor === undefined) return // No live roster supervisor: notify only, never create a goal.
    if (goal === undefined || goal.phase === 'complete') {
      const created = this.#ports.createGoal(projectId,
        '推进本项目所有未结任务到 verified；遇到验收、发布授权或外部依赖时停下并在会话里说明。',
        this.#config.maxGoalRounds)
      this.#ports.log(`goal create project=${projectId} ok=${String(created)}`)
      return
    }
    if (goal.phase === 'paused') this.#ports.resumeGoal(projectId)
  }

  private supervisorId(projectId: string): string | undefined {
    return activeSupervisor(this.#ports.members(projectId))?.sessionId
  }

  /**
   * Execute one supervisor action with roster, state, version and idempotency checks.
   * @param request - action, identity, CAS version and replay key.
   * @returns the new version, or a visible failure code.
   */
  async act(request: StallActionRequest): Promise<StallActionResult> {
    const replayKey = `${request.projectId}\u0000${request.idempotencyKey}`
    const fingerprint = JSON.stringify([
      request.action, request.taskId, request.episodeId, request.expectedVersion,
      request.toSessionId ?? '', request.reason ?? '',
    ])
    const replay = this.#actionResults.get(replayKey)
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT', message: '同一幂等键已用于不同的停摆动作' }
      }
      return replay.result.ok ? { ...replay.result, replayed: true } : replay.result
    }

    const result = await this.#act(request)
    this.#actionResults.set(replayKey, { fingerprint, result })
    return result
  }

  async #act(request: StallActionRequest): Promise<StallActionResult> {
    const members = this.#ports.members(request.projectId)
    const actor = members.find(member => member.sessionId === request.actorSessionId)
    if (actor === undefined || actor.role !== 'supervisor' || actor.state === 'departed' || actor.sessionId === 'sup-1') {
      return { ok: false, code: 'PERMISSION_DENIED', message: '只有本项目在册 supervisor 可以处置停摆任务' }
    }
    const key = this.key(request.projectId, request.taskId)
    const episode = this.#episodes.get(key)
    if (episode === undefined) return { ok: false, code: 'TASK_NOT_FOUND', message: `任务不在停摆视图中：${request.taskId}` }
    if (request.episodeId !== episode.episodeId) {
      return { ok: false, code: 'STALL_ALREADY_RECOVERED', message: '该停摆周期已结束，请刷新后重试' }
    }
    // The CAS version is the task row's optimistic-lock column, read fresh at
    // action time; episode state changes never advance it.
    const fresh = this.#ports.listTasks(request.projectId).find(task => task.taskId === request.taskId)
    if (fresh !== undefined) episode.task = fresh
    const currentVersion = fresh?.version ?? episode.task.version
    if (request.expectedVersion !== currentVersion) {
      return { ok: false, code: 'VERSION_CONFLICT', message: `期望版本 ${String(request.expectedVersion)}，当前 ${String(currentVersion)}` }
    }
    if (episode.state !== 'stalled') {
      return { ok: false, code: 'STALL_NOT_ACTIONABLE', message: `当前状态 ${episode.state} 不可执行 ${request.action}` }
    }
    const now = this.#ports.now()

    if (request.action === 'nudge') {
      if (episode.lastNudgedAt !== undefined && now - episode.lastNudgedAt < this.#config.nudgeCooldownMs) {
        return { ok: false, code: 'NUDGE_COOLDOWN', message: `催办冷却中，还需 ${String(Math.ceil((this.#config.nudgeCooldownMs - (now - episode.lastNudgedAt)) / 1000))} 秒` }
      }
      try {
        await this.#ports.prompt(episode.task.assigneeSessionId,
          `【主管催办】任务 ${episode.task.taskId}「${episode.task.title}」已 ${durationText(now - (episode.lastActivityAt ?? now))} 无活动。请立即继续；如遇阻塞，请用 report_task 或请示主管说明。`)
      } catch (error) {
        return { ok: false, code: 'NUDGE_FAILED', message: error instanceof Error ? error.message : String(error) }
      }
      episode.nudgeCount += 1
      episode.lastNudgedAt = now
      return { ok: true, action: 'nudge', version: currentVersion, replayed: false }
    }

    if (request.action === 'cancel') {
      const reason = request.reason?.trim()
      if (reason === undefined || reason === '') return { ok: false, code: 'CANCEL_NOT_ALLOWED', message: '取消必须填写原因' }
      const outcome = await this.#ports.cancelTask({
        projectId: request.projectId, taskId: request.taskId, actorSessionId: request.actorSessionId, reason,
      })
      if (!outcome.ok) return outcome
      const version = currentVersion + 1
      this.#episodes.delete(key)
      return { ok: true, action: 'cancel', version, replayed: false }
    }

    if (request.action === 'reassign') {
      const reason = request.reason?.trim()
      const target = request.toSessionId === undefined ? undefined : members.find(member => member.sessionId === request.toSessionId)
      if (reason === undefined || reason === '') return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: '重派必须填写原因' }
      if (target === undefined || target.state === 'departed' || target.role !== 'worker') {
        return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: '目标必须是本项目在职员工' }
      }
      const outcome = await this.#ports.reassignTask({
        projectId: request.projectId, taskId: request.taskId, actorSessionId: request.actorSessionId,
        toSessionId: target.sessionId, reason,
      })
      if (!outcome.ok) return outcome
      const version = currentVersion + 1
      this.#episodes.delete(key)
      return { ok: true, action: 'reassign', version, replayed: false }
    }

    const outcome = await this.#ports.escalate({
      projectId: request.projectId, taskId: request.taskId, actorSessionId: request.actorSessionId,
    })
    if (!outcome.ok) return outcome
    episode.escalated = true
    return { ok: true, action: 'escalate', version: currentVersion, replayed: false }
  }
}
