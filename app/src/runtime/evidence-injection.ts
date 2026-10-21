/**
 * 证据卡注入接线（N17 / ADR-0015；A1 v2：user-role 注入可行、system 不可）。
 *
 * 只包装运行时 `EngineSession.send` 的事件流做旁路观察：
 * - `compaction.summary` 且 `raw.data.compactionId`（兼容 `raw.compactionId`）存在时触发；
 * - 当前任务 = 台账中 assigneeSessionId 等于会话且非终态的任务，
 *   多条时取 updatedAt 最新一条（并列再按 seq 最新）——策略会写入诊断；
 * - 读卡 → 校验（失败/stale 一律跳过）→ injector（同键幂等）；
 * - 恢复块在本次事件流结束后，作为 user-role 消息发送给同一会话；
 * - 任何失败只产结构化诊断，不打断主事件流，也不静默。
 *
 * 不 import harness：本文件只依赖 ports/collab 类型与内存/文件能力。
 */
import type { EngineEvent, EngineSession, SendOptions } from '../ports/engine.ts'
import type { TaskLedgerPort } from '../collab/ledger/index.ts'
import type { TaskRecord } from '../collab/ledger/index.ts'
import type { IsoTimestamp, ProjectId, SessionId, TaskId } from '../collab/protocol/index.ts'
import { TERMINAL_TASK_STATUSES } from '../collab/protocol/index.ts'
import {
  EvidenceError,
  EvidenceInjector,
  readEvidenceCard,
  validateEvidenceCard,
  type EvidenceCard,
  type EvidenceIssue,
} from '../collab/evidence/index.ts'

export type InjectionStage =
  | 'event'
  | 'task-lookup'
  | 'card-read'
  | 'card-validation'
  | 'inject'
  | 'delivery'

export type InjectionOutcome = 'injected' | 'delivered' | 'duplicate' | 'skipped' | 'failed'

export interface EvidenceInjectionDiagnostic {
  readonly stage: InjectionStage
  readonly outcome: InjectionOutcome
  readonly reason: string
  readonly compactionId: string
  readonly taskId?: TaskId
  readonly revision?: number
  readonly at: IsoTimestamp
  readonly role?: 'user'
  readonly detail?: Record<string, unknown>
}

export interface EvidenceInjectionOptions {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  /** 证据卡根目录（项目工作区）。 */
  readonly projectRoot: string
  readonly ledger: TaskLedgerPort
  readonly injector?: EvidenceInjector
  /** 默认用原 session.send 作为 user-role 消息发送并抽干事件。 */
  readonly deliver?: (text: string) => Promise<void> | void
  readonly onDiagnostic?: (diagnostic: EvidenceInjectionDiagnostic) => void
  readonly now?: () => IsoTimestamp
  readonly maxTokens?: number
}

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES)

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** A1：稳定 ID 在 event.data.compactionId；映射层 raw 可能已是 data 或含 data。 */
export function extractionCompactionId(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const nested = asRecord(record.data)?.compactionId
  const direct = record.compactionId
  const value = typeof nested === 'string' ? nested : direct
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

interface PendingInjection {
  readonly taskId: TaskId
  readonly compactionId: string
  readonly revision: number
  readonly text: string
  readonly bytes: number
  readonly estimatedTokens: number
}

export class EvidenceInjectionRuntime {
  private readonly options: EvidenceInjectionOptions
  private readonly injector: EvidenceInjector
  private readonly diagnostics: EvidenceInjectionDiagnostic[] = []
  private readonly pending: PendingInjection[] = []

  constructor(options: EvidenceInjectionOptions) {
    this.options = options
    this.injector = options.injector ?? new EvidenceInjector({ projectRoot: options.projectRoot })
  }

  /** 本次包装期间产生的全部诊断（含成功/跳过/失败）。 */
  getDiagnostics(): readonly EvidenceInjectionDiagnostic[] {
    return [...this.diagnostics]
  }

  /**
   * 包装会话：事件原样透传；compaction.summary 先观察再 yield，
   * 保证即使消费者提前 break，也已处理该事件。
   */
  wrap(session: EngineSession): EngineSession {
    return {
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      send: (prompt: string, sendOptions?: SendOptions) =>
        this.observeSend(session, prompt, sendOptions),
      setWorkingDirectory: (path: string) => session.setWorkingDirectory(path),
      getWorkingDirectory: () => session.getWorkingDirectory(),
      close: () => session.close(),
    }
  }

  private async *observeSend(
    session: EngineSession,
    prompt: string,
    sendOptions?: SendOptions,
  ): AsyncIterable<EngineEvent> {
    try {
      for await (const event of session.send(prompt, sendOptions)) {
        if (event.kind === 'compaction.summary') this.handleCompactionSummary(event.raw)
        yield event
      }
    } finally {
      await this.flush(session)
    }
  }

  private now(): IsoTimestamp {
    return (this.options.now ?? (() => new Date().toISOString() as IsoTimestamp))()
  }

  private emit(diagnostic: Omit<EvidenceInjectionDiagnostic, 'at'>): void {
    const full: EvidenceInjectionDiagnostic = { ...diagnostic, at: this.now() }
    this.diagnostics.push(full)
    try {
      this.options.onDiagnostic?.(full)
    } catch {
      // logger 自身异常不得打断事件流。
    }
  }

  private handleCompactionSummary(raw: unknown): void {
    const compactionId = extractionCompactionId(raw)
    if (compactionId === undefined) {
      this.emit({
        stage: 'event',
        outcome: 'skipped',
        reason: 'missing-compaction-id',
        compactionId: '',
      })
      return
    }

    const candidates = this.findCurrentTasks()
    if (candidates.length === 0) {
      this.emit({
        stage: 'task-lookup',
        outcome: 'skipped',
        reason: 'no-active-task',
        compactionId,
      })
      return
    }
    const task = candidates[0] as TaskRecord
    const selection = {
      strategy: 'latest-updatedAt-then-seq',
      candidateCount: candidates.length,
    }

    const card = this.loadCard(task, compactionId)
    if (card === undefined) return

    if (card.taskId !== task.taskId) {
      this.emit({
        stage: 'card-validation',
        outcome: 'skipped',
        reason: 'card-task-mismatch',
        compactionId,
        taskId: task.taskId,
        revision: card.revision,
        detail: { cardTaskId: card.taskId, ...selection },
      })
      return
    }

    const report = validateEvidenceCard(card, { projectRoot: this.options.projectRoot })
    if (!report.ok) {
      const stale = report.staleItemIds.length > 0
      this.emit({
        stage: 'card-validation',
        outcome: 'skipped',
        reason: stale ? 'card-stale' : 'card-invalid',
        compactionId,
        taskId: task.taskId,
        revision: card.revision,
        detail: {
          issues: report.issues.map((issue: EvidenceIssue) => issue.code),
          staleItemIds: [...report.staleItemIds],
          ...selection,
        },
      })
      return
    }

    let outcome
    try {
      outcome = this.injector.inject(card, {
        compactionId,
        sessionId: String(this.options.sessionId),
        ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
      })
    } catch (error) {
      this.emit({
        stage: 'inject',
        outcome: 'failed',
        reason: 'injector-error',
        compactionId,
        taskId: task.taskId,
        revision: card.revision,
        detail: { error: errorText(error), ...selection },
      })
      return
    }

    if (outcome.status === 'duplicate') {
      this.emit({
        stage: 'inject',
        outcome: 'duplicate',
        reason: 'same-key-already-injected',
        compactionId,
        taskId: task.taskId,
        revision: card.revision,
        role: 'user',
        detail: selection,
      })
      return
    }

    this.pending.push({
      taskId: task.taskId,
      compactionId,
      revision: card.revision,
      text: outcome.text,
      bytes: outcome.bytes,
      estimatedTokens: outcome.estimatedTokens,
    })
    this.emit({
      stage: 'inject',
      outcome: 'injected',
      reason: 'recovery-block-queued',
      compactionId,
      taskId: task.taskId,
      revision: card.revision,
      role: 'user',
      detail: {
        bytes: outcome.bytes,
        estimatedTokens: outcome.estimatedTokens,
        truncated: outcome.truncated,
        ...selection,
      },
    })
  }

  private findCurrentTasks(): readonly TaskRecord[] {
    let tasks: readonly TaskRecord[]
    try {
      tasks = this.options.ledger.listTasks(this.options.projectId)
    } catch (error) {
      this.emit({
        stage: 'task-lookup',
        outcome: 'failed',
        reason: 'ledger-error',
        compactionId: '',
        detail: { error: errorText(error) },
      })
      return []
    }
    return tasks
      .filter(
        (task) =>
          task.assigneeSessionId === this.options.sessionId && !TERMINAL.has(task.status),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq)
  }

  private loadCard(task: TaskRecord, compactionId: string): EvidenceCard | undefined {
    try {
      return readEvidenceCard(this.options.projectRoot, String(task.taskId))
    } catch (error) {
      const code = error instanceof EvidenceError ? error.code : 'READ_FAILED'
      this.emit({
        stage: 'card-read',
        outcome: 'skipped',
        reason: code === 'CARD_NOT_FOUND' ? 'card-not-found' : 'card-corrupt',
        compactionId,
        taskId: task.taskId,
        detail: { error: errorText(error) },
      })
      return undefined
    }
  }

  /** 在本次 send 结束后按 user-role 发送排队的恢复块。 */
  private async flush(session: EngineSession): Promise<void> {
    const pending = this.pending.splice(0, this.pending.length)
    for (const item of pending) {
      try {
        if (this.options.deliver !== undefined) {
          await this.options.deliver(item.text)
        } else {
          // 复用 EngineSession.send（user-role 轮次）；抽干事件避免悬挂。
          for await (const _event of session.send(item.text)) {
            // 恢复块自身运行产生的压缩事件不再观察，避免递归注入。
          }
        }
        this.emit({
          stage: 'delivery',
          outcome: 'delivered',
          reason: 'sent-as-user-role',
          compactionId: item.compactionId,
          taskId: item.taskId,
          revision: item.revision,
          role: 'user',
          detail: { bytes: item.bytes, estimatedTokens: item.estimatedTokens },
        })
      } catch (error) {
        this.emit({
          stage: 'delivery',
          outcome: 'failed',
          reason: 'delivery-failed',
          compactionId: item.compactionId,
          taskId: item.taskId,
          revision: item.revision,
          role: 'user',
          detail: { error: errorText(error) },
        })
      }
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 便捷入口：返回包装后的会话；诊断通过 options.onDiagnostic 输出。 */
export function wrapSessionWithEvidenceInjection(
  session: EngineSession,
  options: EvidenceInjectionOptions,
): EngineSession {
  return new EvidenceInjectionRuntime(options).wrap(session)
}
