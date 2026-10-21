/**
 * 证据卡恢复块注入（spike/03 §4；A1 v2：user-role 可行、system 不可）。
 *
 * - 固定标记 `[EVIDENCE CARD RECOVERY]`；只含摘要与指针，不注入全文；
 * - 预算按 200 tokens 量级（估算 UTF-8 bytes / 4，记录真实字节数）；
 * - 幂等键 `(taskId, compactionId, revision)`：同键跳过，异键放行；
 * - 不依赖 harness 摘要质量，也不调用模型。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { IsoTimestamp } from '../protocol/index.ts'
import { EvidenceError } from './errors.ts'
import { evidenceRoot } from './fs-utils.ts'
import type { EvidenceCard, EvidenceItem } from './types.ts'

export const RECOVERY_MARKER = '[EVIDENCE CARD RECOVERY]'
export const DEFAULT_MAX_TOKENS = 200
const TOKEN_BYTES = 4

export interface RecoveryBlock {
  readonly text: string
  readonly bytes: number
  readonly estimatedTokens: number
  readonly truncated: boolean
}

export interface RecoveryBlockOptions {
  readonly compactionId: string
  readonly maxTokens?: number
}

export interface EvidenceInjectionRecord {
  readonly key: string
  readonly taskId: string
  readonly compactionId: string
  readonly revision: number
  readonly sessionId?: string
  readonly role: 'user'
  readonly injectedAt: IsoTimestamp
  readonly bytes: number
  readonly estimatedTokens: number
  readonly truncated: boolean
}

export type InjectionOutcome =
  | ({ readonly status: 'injected'; readonly key: string } & RecoveryBlock)
  | { readonly status: 'duplicate'; readonly key: string; readonly record: EvidenceInjectionRecord }

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / TOKEN_BYTES)
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

interface BlockInputs {
  readonly card: EvidenceCard
  readonly compactionId: string
  readonly numbers: readonly EvidenceItem[]
  readonly commands: readonly EvidenceItem[]
  readonly semantic: readonly EvidenceItem[]
  readonly unverified: readonly EvidenceItem[]
  readonly files: readonly string[]
  readonly maxTokens: number
  readonly currentLimit: number
  readonly nextLimit: number
}

function render(input: BlockInputs): RecoveryBlock {
  const { card, compactionId } = input
  const lines: string[] = [
    RECOVERY_MARKER,
    `task: ${card.taskId} | rev ${card.revision} | updated ${card.updatedAt}`,
    `compaction: ${compactionId}`,
    `current: ${oneLine(card.currentTask).slice(0, input.currentLimit)}`,
    `next: ${oneLine(card.nextStep).slice(0, input.nextLimit)}`,
    `files: ${input.files.length} referenced${input.files.length === 0 ? '' : ` | ${input.files.slice(0, 5).join(', ')}`}`,
  ]
  if (input.numbers.length > 0) {
    lines.push(
      `numbers: ${input.numbers
        .slice(0, 5)
        .map((item) => {
          const location =
            item.source?.file === undefined
              ? ''
              : ` @ ${item.source.file}${item.source.line === undefined ? '' : `:${item.source.line}`}`
          return `${oneLine(item.value)}${location}`
        })
        .join('; ')}`,
    )
  }
  if (input.commands.length > 0) {
    lines.push(
      `commands: ${input.commands
        .slice(0, 3)
        .map(
          (item) =>
            `${oneLine(item.source?.command ?? item.value)} -> ${item.source?.exitCode ?? '?'}`,
        )
        .join('; ')}`,
    )
  }
  if (input.semantic.length > 0) {
    lines.push(
      `semantic: ${input.semantic
        .slice(0, 5)
        .map((item) => `${oneLine(item.item)}: ${oneLine(item.value)}`)
        .join('; ')}`,
    )
  }
  lines.push(
    input.unverified.length === 0
      ? 'unverified: none'
      : `unverified: ${input.unverified
          .slice(0, 5)
          .map((item) => `${oneLine(item.item)} (need: ${oneLine(item.neededEvidence ?? '')})`)
          .join('; ')}`,
  )
  lines.push(
    `full: ${oneLine(card.pointer?.file ?? card.pointer?.cardPath ?? `evidence_card.read(${card.taskId})`)}`,
  )
  lines.push('rule: 不得凭记忆补写；先核对卡片/源码再行动。')

  const text = `${lines.join('\n')}\n`
  const estimatedTokens = estimateTokens(text)
  return {
    text,
    bytes: bytesOf(text),
    estimatedTokens,
    truncated: estimatedTokens > input.maxTokens,
  }
}

/** 生成 user-role 恢复块；超预算时先裁列表，再截断 current/next。 */
export function buildRecoveryBlock(
  card: EvidenceCard,
  options: RecoveryBlockOptions,
): RecoveryBlock {
  if (options.compactionId.trim() === '') {
    throw new EvidenceError('INVALID_CARD', 'compactionId 不得为空')
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const exact = card.items.filter((item) => item.kind === 'exact' && item.status === 'ok')
  const numbers = exact.filter((item) => item.source?.file !== undefined)
  const commands = exact.filter((item) => item.source?.command !== undefined)
  const semantic = card.items.filter((item) => item.kind === 'semantic' && item.status === 'ok')
  const unverified = card.items.filter((item) => item.status === 'unverified')
  const files = [
    ...new Set(
      card.items
        .map((item) => item.source?.file)
        .filter((file): file is string => file !== undefined),
    ),
  ]

  const finalize = (block: RecoveryBlock, trimmed: boolean): RecoveryBlock =>
    trimmed || block.estimatedTokens > maxTokens ? { ...block, truncated: true } : block

  const full: BlockInputs = {
    card,
    compactionId: options.compactionId,
    numbers,
    commands,
    semantic,
    unverified,
    files,
    maxTokens,
    currentLimit: Number.POSITIVE_INFINITY,
    nextLimit: Number.POSITIVE_INFINITY,
  }
  let block = render(full)
  if (block.estimatedTokens <= maxTokens) return block

  // 第一轮：列表降为计数。
  block = render({
    ...full,
    numbers: [],
    commands: [],
    semantic: [],
    unverified,
    currentLimit: Number.POSITIVE_INFINITY,
    nextLimit: Number.POSITIVE_INFINITY,
  })
  if (block.estimatedTokens <= maxTokens) return finalize(block, true)

  // 第二轮：逐步截断 current/next 与 unverified。
  for (const limit of [160, 96, 64]) {
    block = render({
      ...full,
      numbers: [],
      commands: [],
      semantic: [],
      unverified: unverified.slice(0, 2),
      currentLimit: limit,
      nextLimit: limit,
    })
    if (block.estimatedTokens <= maxTokens) return finalize(block, true)
  }

  // 最小块：保留 task/current/next/full/rule。
  block = render({
    ...full,
    numbers: [],
    commands: [],
    semantic: [],
    unverified: [],
    files: [],
    currentLimit: 48,
    nextLimit: 48,
  })
  return finalize(block, true)
}

export function injectionKey(taskId: string, compactionId: string, revision: number): string {
  return `${taskId}\u0000${compactionId}\u0000${revision}`
}

function injectionsPath(projectRoot: string): string {
  return `${evidenceRoot(projectRoot)}/injections.jsonl`
}

export function readInjectionRecords(projectRoot: string): readonly EvidenceInjectionRecord[] {
  const path = injectionsPath(projectRoot)
  if (!existsSync(path)) return []
  const records: EvidenceInjectionRecord[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as EvidenceInjectionRecord)
    } catch {
      // 损坏行不阻断后续读取。
    }
  }
  return records
}

export interface InjectOptions {
  readonly compactionId: string
  readonly sessionId?: string
  readonly maxTokens?: number
  readonly now?: () => IsoTimestamp
}

/**
 * 注入器：同键（taskId, compactionId, revision）重放返回 duplicate，不生成第二块；
 * 异任务/异压缩事件/异 revision 均放行。
 */
export class EvidenceInjector {
  private readonly projectRoot: string
  private readonly now: () => IsoTimestamp

  constructor(options: { readonly projectRoot: string; readonly now?: () => IsoTimestamp }) {
    this.projectRoot = options.projectRoot
    this.now = options.now ?? (() => new Date().toISOString() as IsoTimestamp)
  }

  inject(card: EvidenceCard, options: InjectOptions): InjectionOutcome {
    const revision = card.revision
    const key = injectionKey(card.taskId, options.compactionId, revision)
    const existing = readInjectionRecords(this.projectRoot).find((record) => record.key === key)
    if (existing !== undefined) return { status: 'duplicate', key, record: existing }

    const block = buildRecoveryBlock(card, {
      compactionId: options.compactionId,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    })
    const record: EvidenceInjectionRecord = {
      key,
      taskId: card.taskId,
      compactionId: options.compactionId,
      revision,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      role: 'user',
      injectedAt: this.now(),
      bytes: block.bytes,
      estimatedTokens: block.estimatedTokens,
      truncated: block.truncated,
    }
    const dir = evidenceRoot(this.projectRoot)
    mkdirSync(dir, { recursive: true })
    appendFileSync(injectionsPath(this.projectRoot), `${JSON.stringify(record)}\n`, 'utf8')
    return { status: 'injected', key, ...block }
  }
}
