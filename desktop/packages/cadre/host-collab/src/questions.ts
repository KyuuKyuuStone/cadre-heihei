/**
 * Worker questions are routed to the supervisor instead of the user UI.
 *
 * The router owns the in-memory pending queue and its 30-minute escalation.
 * It is transport-free so role checks, answer validation, and timeout behaviour
 * are testable without Cordis or a live Session.
 * @module
 */

/** One option the employee offered. */
export interface RoutedOption {
  readonly label: string
  readonly description?: string
}

/** One question from `ask_user_question`. */
export interface RoutedQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly RoutedOption[]
  readonly multiSelect?: boolean
}

/** The waterfall request payload used by this router. */
export interface RoutedRequest {
  readonly questions: readonly RoutedQuestion[]
  readonly agent?: { readonly id: string }
  readonly signal?: AbortSignal
  readonly wait?: { readonly callId: string; readonly timed?: boolean }
}

/** Answer batch returned to the official tool. */
export interface RoutedAnswer {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

/** One supervisor reply to `resolve_employee_question`. */
export interface ResolveRequest {
  readonly questionId: string
  readonly action: 'answer' | 'reject' | 'escalate'
  readonly answers?: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
  readonly reason?: string
}

/** Result of a resolve call, surfaced to the supervisor tool. */
export type ResolveResult =
  | { readonly ok: true; readonly state: QuestionState; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Queue state. `timed-out` stays answerable; `escalated` is still pending. */
export type QuestionState = 'pending' | 'answered' | 'rejected' | 'cancelled' | 'timed-out' | 'escalated'

/** IO the router needs; every failure is logged or rejected, never swallowed. */
export interface QuestionPorts {
  member(sessionId: string): { readonly projectId: string; readonly role: string; readonly state: string } | undefined
  openTask(projectId: string, workerSessionId: string): { readonly taskId: string; readonly title: string; readonly dispatcherSessionId?: string } | undefined
  supervisor(projectId: string): string | undefined
  name(projectId: string, sessionId: string): string
  prompt(sessionId: string, text: string): Promise<void>
  log(message: string): void
  now(): number
  newId(): string
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

interface Pending {
  readonly questionId: string
  readonly projectId: string
  readonly workerSessionId: string
  readonly workerName: string
  readonly targetSessionId: string
  readonly taskId?: string
  readonly taskTitle?: string
  readonly questions: readonly RoutedQuestion[]
  readonly createdAt: number
  readonly resolve: (answer: RoutedAnswer) => void
  readonly reject: (error: Error) => void
  state: QuestionState
  escalated: boolean
  timer: unknown
  detachSignal?: () => void
}

/** Default time before the supervisor prompt is escalated to the user. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60_000
/** Default per-worker pending cap. */
export const DEFAULT_MAX_PENDING_PER_WORKER = 20

function optionLabels(question: RoutedQuestion): string[] {
  return (question.options ?? []).map(option => option.label)
}

function renderQuestions(questions: readonly RoutedQuestion[]): string {
  return questions.map((question, index) => {
    const head = `${String(index + 1)}. ${question.header === undefined ? '' : `[${question.header}] `}${question.question}`
    const detail = question.detail === undefined ? '' : `\n   说明：${question.detail}`
    const options = optionLabels(question)
    const choices = options.length === 0
      ? '\n   选项：无（自由回答）'
      : `\n   选项：${options.map(label => `「${label}」`).join(' / ')}${question.multiSelect === true ? '（可多选）' : ''}`
    return `${head}${detail}${choices}`
  }).join('\n')
}

/**
 * In-memory worker-question router.
 *
 * A worker request never delegates to the official answerer; it resolves only
 * through {@link QuestionRouter.resolve} (or rejects on abort). A supervisor
 * request is left to the caller's `next()`.
 */
export class QuestionRouter {
  readonly #ports: QuestionPorts
  readonly #timeoutMs: number
  readonly #maxPending: number
  readonly #pending = new Map<string, Pending>()

  constructor(ports: QuestionPorts, options: { timeoutMs?: number; maxPendingPerWorker?: number } = {}) {
    this.#ports = ports
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS
    this.#maxPending = options.maxPendingPerWorker ?? DEFAULT_MAX_PENDING_PER_WORKER
  }

  /** Current pending queue size (tests and the Host view). */
  get size(): number {
    return this.#pending.size
  }

  /** One pending question by id, if still known. */
  get(questionId: string): { state: QuestionState; projectId: string; targetSessionId: string } | undefined {
    const pending = this.#pending.get(questionId)
    return pending === undefined
      ? undefined
      : { state: pending.state, projectId: pending.projectId, targetSessionId: pending.targetSessionId }
  }

  /** Reject every pending question and clear timers; called on plugin unload. */
  dispose(): void {
    for (const [questionId, pending] of this.#pending) {
      this.#finish(questionId, 'cancelled')
      pending.reject(new Error('CADRE_QUESTION_CANCELLED: 请示路由已停止'))
    }
    this.#pending.clear()
  }

  /**
   * Intercept one `user-questions/request`.
   * @param request - the official waterfall payload.
   * @param agentId - the requesting root Agent id.
   * @returns the answer for a routed worker request, or `undefined` to delegate.
   */
  async intercept(request: RoutedRequest, agentId: string): Promise<RoutedAnswer | undefined> {
    const member = this.#ports.member(agentId)
    // No roster row or a supervisor/other role keeps the official UI behaviour.
    if (member === undefined || member.role !== 'worker' || member.state === 'departed') return undefined

    const task = this.#ports.openTask(member.projectId, agentId)
    const target = task?.dispatcherSessionId ?? this.#ports.supervisor(member.projectId)
    if (target === undefined || target === '') {
      throw new Error('CADRE_NO_SUPERVISOR: 本项目没有可接收请示的主管，问题已拦截但无法路由；请联系用户登记主管')
    }
    const own = [...this.#pending.values()].filter(pending => pending.workerSessionId === agentId && pending.state === 'pending')
    if (own.length >= this.#maxPending) {
      throw new Error(`CADRE_QUESTION_LIMIT: 待答问题已达 ${String(this.#maxPending)} 条，请先让主管处理队列`)
    }

    const questionId = request.wait?.callId ?? `ask-${this.#ports.newId()}`
    let resolve!: (answer: RoutedAnswer) => void
    let reject!: (error: Error) => void
    const promise = new Promise<RoutedAnswer>((res, rej) => { resolve = res; reject = rej })
    const pending: Pending = {
      questionId,
      projectId: member.projectId,
      workerSessionId: agentId,
      workerName: this.#ports.name(member.projectId, agentId),
      targetSessionId: target,
      ...(task === undefined ? {} : { taskId: task.taskId, taskTitle: task.title }),
      questions: request.questions,
      createdAt: this.#ports.now(),
      resolve,
      reject,
      state: 'pending',
      escalated: false,
      timer: undefined,
    }
    this.#pending.set(questionId, pending)
    pending.timer = this.#ports.setTimer(() => { void this.#timeout(questionId) }, this.#timeoutMs)
    if (request.signal !== undefined) {
      const onAbort = (): void => { this.#cancel(questionId, '员工已取消问题') }
      request.signal.addEventListener('abort', onAbort, { once: true })
      pending.detachSignal = () => request.signal?.removeEventListener('abort', onAbort)
    }

    const where = task === undefined ? '（无进行中的任务）' : `${task.taskId}「${task.title}」`
    const text = [
      `【员工请示 #${questionId}】${pending.workerName}（${agentId}）在任务 ${where} 提问：`,
      renderQuestions(request.questions),
      '请用 resolve_employee_question 回答（或驳回/升级）；超时 30 分钟会自动升级。',
    ].join('\n')
    try {
      await this.#ports.prompt(target, text)
      this.#ports.log(`question routed id=${questionId} worker=${agentId} target=${target} project=${member.projectId}`)
    } catch (error) {
      this.#finish(questionId, 'cancelled')
      reject(new Error(`CADRE_SUPERVISOR_UNREACHABLE: 主管会话不可达（${error instanceof Error ? error.message : String(error)}）`))
      return promise
    }
    return promise
  }

  /**
   * Apply one supervisor answer/reject/escalate.
   * @param request - question id, action, answers, reason.
   * @param actorSessionId - the supervisor's root Agent id (roster-verified).
   * @returns the new queue state, or a visible failure code.
   */
  async resolve(request: ResolveRequest, actorSessionId: string): Promise<ResolveResult> {
    const actor = this.#ports.member(actorSessionId)
    if (actor === undefined || actor.role !== 'supervisor' || actor.state === 'departed') {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '只有主管可以处理员工请示' }
    }
    const pending = this.#pending.get(request.questionId)
    if (pending === undefined) return { ok: false, code: 'QUESTION_NOT_FOUND', message: `请示不存在或已结束：${request.questionId}` }
    if (pending.projectId !== actor.projectId) {
      return { ok: false, code: 'CROSS_PROJECT_DENIED', message: '不能处理其他项目部的请示' }
    }
    if (pending.targetSessionId !== actorSessionId && this.#ports.supervisor(pending.projectId) !== actorSessionId) {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '该请示路由给了另一位主管' }
    }
    if (pending.state === 'answered' || pending.state === 'rejected' || pending.state === 'cancelled') {
      return { ok: true, state: pending.state, replayed: true }
    }

    if (request.action === 'escalate') {
      if (!pending.escalated) {
        pending.escalated = true
        pending.state = 'escalated'
        try {
          await this.#ports.prompt(pending.targetSessionId,
            `【请示升级 #${pending.questionId}】${pending.workerName} 的问题已由主管升级给用户。请用 ask_user_question 向用户确认后，再用 resolve_employee_question 回答员工。`)
          this.#ports.log(`question escalated id=${pending.questionId} by=${actorSessionId} reason=${request.reason ?? ''}`)
        } catch (error) {
          this.#ports.log(`question escalate prompt failed id=${pending.questionId} reason=${error instanceof Error ? error.message : String(error)}`)
          return { ok: false, code: 'ESCALATE_FAILED', message: '升级消息投递失败，请稍后重试' }
        }
      }
      return { ok: true, state: 'escalated', replayed: pending.escalated }
    }

    if (request.action === 'reject') {
      const reason = request.reason?.trim() ?? ''
      if (reason === '') return { ok: false, code: 'REJECT_REASON_REQUIRED', message: '驳回必须说明理由' }
      this.#finish(request.questionId, 'rejected')
      pending.reject(new Error(`CADRE_QUESTION_REJECTED: ${reason}`))
      this.#ports.log(`question rejected id=${pending.questionId} by=${actorSessionId} reason=${reason}`)
      return { ok: true, state: 'rejected', replayed: false }
    }

    const answers = request.answers ?? []
    const invalid = this.#validateAnswers(pending.questions, answers)
    if (invalid !== undefined) return { ok: false, code: 'BAD_ANSWER', message: invalid }
    this.#finish(request.questionId, 'answered')
    pending.resolve({ answers })
    this.#ports.log(`question answered id=${pending.questionId} by=${actorSessionId}`)
    return { ok: true, state: 'answered', replayed: false }
  }

  #validateAnswers(questions: readonly RoutedQuestion[], answers: readonly { id: string; selected: readonly string[] }[]): string | undefined {
    if (answers.length !== questions.length) {
      return `必须逐题回答：${String(questions.length)} 题，收到 ${String(answers.length)} 条答案`
    }
    const byId = new Map(answers.map(answer => [answer.id, answer]))
    if (byId.size !== answers.length) return '答案里出现重复的 question id'
    for (const question of questions) {
      const answer = byId.get(question.id)
      if (answer === undefined) return `缺少问题 ${question.id} 的答案`
      if (question.multiSelect !== true && answer.selected.length > 1) return `问题 ${question.id} 只能选一个选项`
      const allowed = new Set(optionLabels(question))
      for (const selected of answer.selected) {
        if (allowed.size > 0 && !allowed.has(selected)) return `问题 ${question.id} 的选项「${selected}」不存在`
      }
    }
    return undefined
  }

  async #timeout(questionId: string): Promise<void> {
    const pending = this.#pending.get(questionId)
    if (pending === undefined || pending.state !== 'pending' || pending.escalated) return
    pending.escalated = true
    pending.state = 'timed-out'
    try {
      await this.#ports.prompt(pending.targetSessionId,
        `【请示超时升级 #${questionId}】${pending.workerName} 的问题已等待 30 分钟未答，已升级给用户。请尽快处理并回复员工。`)
      this.#ports.log(`question timeout id=${questionId} target=${pending.targetSessionId}`)
    } catch (error) {
      this.#ports.log(`question timeout prompt failed id=${questionId} reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #cancel(questionId: string, reason: string): void {
    const pending = this.#pending.get(questionId)
    if (pending === undefined) return
    if (pending.state !== 'pending' && pending.state !== 'timed-out' && pending.state !== 'escalated') return
    this.#finish(questionId, 'cancelled')
    pending.reject(new Error(`CADRE_QUESTION_CANCELLED: ${reason}`))
    this.#ports.log(`question cancelled id=${questionId}`)
  }

  #finish(questionId: string, state: QuestionState): void {
    const pending = this.#pending.get(questionId)
    if (pending === undefined) return
    pending.state = state
    this.#ports.clearTimer(pending.timer)
    pending.detachSignal?.()
  }
}
