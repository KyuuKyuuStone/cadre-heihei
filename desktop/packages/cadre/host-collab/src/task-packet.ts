/**
 * TaskPacket normalization and employee-facing context assembly. A packet is
 * the entire task input for an employee; supervisor history is never included.
 * @module
 */

/** Per-field bounds enforced by {@link normalizeTaskPacket}. */
export const TASK_PACKET_LIMITS = {
  goalChars: 200,
  listItems: 10,
  fileRefs: 20,
  itemChars: 200,
  filePathChars: 300,
  fileSummaryChars: 120,
} as const

/** One referenced file, never its full contents. */
export interface TaskFileRef {
  readonly path: string
  readonly lines?: string
  readonly summary?: string
}

/** Normalized six-field task packet. */
export interface TaskPacket {
  readonly goal: string
  readonly constraints: readonly string[]
  readonly fileRefs: readonly TaskFileRef[]
  readonly acceptance: readonly string[]
  readonly forbidden: readonly string[]
  readonly openQuestions: readonly string[]
}

/** Optional packet input; omitted fields fall back to title/body. */
export interface TaskPacketInput {
  readonly goal?: unknown
  readonly constraints?: unknown
  readonly fileRefs?: unknown
  readonly acceptance?: unknown
  readonly forbidden?: unknown
  readonly openQuestions?: unknown
}

/** A truncation or fallback applied while normalizing. */
export type TaskPacketWarning =
  | 'goal-fallback'
  | 'goal-truncated'
  | 'constraints-truncated'
  | 'fileRefs-truncated'
  | 'acceptance-truncated'
  | 'forbidden-truncated'
  | 'openQuestions-truncated'

/** Normalized packet plus any truncation/fallback warnings. */
export interface NormalizedTaskPacket {
  readonly packet: TaskPacket
  readonly warnings: readonly TaskPacketWarning[]
}

/** Token ceilings; advisory only, never a hard stop. */
export const TOKEN_BUDGET = { task: 30_000, round: 8_000, warnRatio: 0.8 } as const

/** Advisory warning raised at 80% of a task or round ceiling. */
export type TokenWarning = 'task-80%' | 'round-80%'

/** Ambiguity waiting policy; callers may wire reminders/escations later. */
export const AMBIGUITY_POLICY = { remindAfterMs: 600_000, escalateAfterMs: 1_800_000 } as const

/** Action for an employee waiting on a supervisor answer. */
export type AmbiguityAction = 'none' | 'remind' | 'escalate'

/**
 * Classify how long an unanswered ambiguity question has waited.
 * @param elapsedMs - Milliseconds since the question was asked.
 * @returns `remind` at 10 minutes, `escalate` at 30 minutes, else `none`.
 */
export function ambiguityAction(elapsedMs: number): AmbiguityAction {
  if (elapsedMs >= AMBIGUITY_POLICY.escalateAfterMs) return 'escalate'
  if (elapsedMs >= AMBIGUITY_POLICY.remindAfterMs) return 'remind'
  return 'none'
}

/** Per-dispatch token metric exposed to the supervisor. */
export interface TokenMetric {
  readonly taskId: string
  readonly sessionId: string
  readonly estimatedTokens: number
  readonly warnings: readonly TokenWarning[]
}

/**
 * Normalize a packet, truncating each field to its limit and filling a missing
 * goal with the title and a missing acceptance list with the body.
 * @param input - Raw packet fields from the dispatch tool.
 * @param fallback - Title/body used when a required field is absent.
 * @returns Normalized packet and truncation warnings.
 */
export function normalizeTaskPacket(
  input: TaskPacketInput | undefined,
  fallback: { readonly title: string; readonly body: string },
): NormalizedTaskPacket {
  const warnings: TaskPacketWarning[] = []
  const goal = boundedText(input?.goal, TASK_PACKET_LIMITS.goalChars)
  const normalizedGoal = goal.text === ''
    ? (warnings.push('goal-fallback'), boundedText(fallback.title, TASK_PACKET_LIMITS.goalChars).text)
    : goal.text
  if (goal.truncated) warnings.push('goal-truncated')
  if (normalizedGoal === '') throw new Error('TaskPacket.goal 不能为空')
  const constraints = textList(input?.constraints, TASK_PACKET_LIMITS.listItems, TASK_PACKET_LIMITS.itemChars)
  if (constraints.truncated) warnings.push('constraints-truncated')
  const acceptance = textList(input?.acceptance, TASK_PACKET_LIMITS.listItems, TASK_PACKET_LIMITS.itemChars)
  if (acceptance.truncated) warnings.push('acceptance-truncated')
  const normalizedAcceptance = acceptance.values.length === 0
    ? textList([fallback.body], TASK_PACKET_LIMITS.listItems, TASK_PACKET_LIMITS.itemChars).values
    : acceptance.values
  const forbidden = textList(input?.forbidden, TASK_PACKET_LIMITS.listItems, TASK_PACKET_LIMITS.itemChars)
  if (forbidden.truncated) warnings.push('forbidden-truncated')
  const openQuestions = textList(input?.openQuestions, TASK_PACKET_LIMITS.listItems, TASK_PACKET_LIMITS.itemChars)
  if (openQuestions.truncated) warnings.push('openQuestions-truncated')
  const fileRefs = normalizeFileRefs(input?.fileRefs)
  if (fileRefs.truncated) warnings.push('fileRefs-truncated')
  return {
    packet: {
      goal: normalizedGoal,
      constraints: constraints.values,
      fileRefs: fileRefs.values,
      acceptance: normalizedAcceptance,
      forbidden: forbidden.values,
      openQuestions: openQuestions.values,
    },
    warnings,
  }
}

/**
 * Render the employee-visible context: packet + optional recent turn only.
 * It never accepts or emits supervisor history.
 * @param packet - Normalized task packet.
 * @param options - Optional one-turn tail for continuity.
 * @returns Prompt text for the employee session.
 */
export function buildEmployeeContext(
  packet: TaskPacket,
  options: { readonly lastTurn?: string } = {},
): string {
  const lines = [
    '【员工任务包】',
    `目标：${packet.goal}`,
    `约束：${packet.constraints.length === 0 ? '无' : packet.constraints.join('；')}`,
    `文件引用：${packet.fileRefs.length === 0 ? '无' : packet.fileRefs.map(renderFileRef).join('；')}`,
    `验收：${packet.acceptance.length === 0 ? '无' : packet.acceptance.join('；')}`,
    `禁止项：${packet.forbidden.length === 0 ? '无' : packet.forbidden.join('；')}`,
    `未决问题：${packet.openQuestions.length === 0 ? '无' : packet.openQuestions.join('；')}`,
    '',
    '【上下文边界】只使用本任务包与按需读取的文件引用；不要读取、推断或复述主管完整历史。',
    '【歧义处理】目标/验收/引用不足时先向主管提问，不要猜；主管回复前不要跳过验收项。',
  ]
  if (options.lastTurn !== undefined && options.lastTurn.trim() !== '') {
    lines.push('', '【上一轮摘要】', options.lastTurn.trim().slice(0, 1_000))
  }
  return lines.join('\n')
}

/** Estimate tokens conservatively; CJK text is roughly one token per character. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2))
}

/**
 * Measure one dispatch against the advisory task/round budgets.
 * @param input - Identity, estimated tokens and current totals.
 * @returns Metric with 80% warnings; it never truncates.
 */
export function measureTokenBudget(input: {
  readonly taskId: string
  readonly sessionId: string
  readonly estimatedTokens: number
  readonly taskTotal?: number
  readonly roundTotal?: number
}): TokenMetric {
  const taskTotal = input.taskTotal ?? input.estimatedTokens
  const roundTotal = input.roundTotal ?? input.estimatedTokens
  const warnings: TokenWarning[] = []
  if (taskTotal >= TOKEN_BUDGET.task * TOKEN_BUDGET.warnRatio) warnings.push('task-80%')
  if (roundTotal >= TOKEN_BUDGET.round * TOKEN_BUDGET.warnRatio) warnings.push('round-80%')
  return {
    taskId: input.taskId,
    sessionId: input.sessionId,
    estimatedTokens: input.estimatedTokens,
    warnings,
  }
}

function renderFileRef(ref: TaskFileRef): string {
  return [ref.path, ref.lines === undefined ? '' : `:${ref.lines}`, ref.summary === undefined ? '' : `（${ref.summary}）`].join('')
}

function boundedText(value: unknown, max: number): { text: string; truncated: boolean } {
  if (typeof value !== 'string') return { text: '', truncated: false }
  const text = value.trim()
  return text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

function textList(value: unknown, maxItems: number, maxChars: number): { values: string[]; truncated: boolean } {
  const raw = Array.isArray(value) ? value : typeof value === 'string' && value.trim() !== '' ? [value] : []
  const values: string[] = []
  let truncated = false
  for (const item of raw) {
    if (values.length >= maxItems) { truncated = true; break }
    if (typeof item !== 'string') continue
    const bounded = boundedText(item, maxChars)
    if (bounded.text !== '') values.push(bounded.text)
    if (bounded.truncated) truncated = true
  }
  return { values, truncated }
}

function normalizeFileRefs(value: unknown): { values: TaskFileRef[]; truncated: boolean } {
  const raw = Array.isArray(value) ? value : []
  const values: TaskFileRef[] = []
  let truncated = false
  for (const item of raw) {
    if (values.length >= TASK_PACKET_LIMITS.fileRefs) { truncated = true; break }
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const path = boundedText(typeof item === 'string' ? item : record.path, TASK_PACKET_LIMITS.filePathChars)
    if (path.text === '') continue
    const lines = boundedText(record.lines, 40)
    const summary = boundedText(record.summary, TASK_PACKET_LIMITS.fileSummaryChars)
    if (path.truncated || lines.truncated || summary.truncated) truncated = true
    values.push({
      path: path.text,
      ...(lines.text === '' ? {} : { lines: lines.text }),
      ...(summary.text === '' ? {} : { summary: summary.text }),
    })
  }
  return { values, truncated }
}
