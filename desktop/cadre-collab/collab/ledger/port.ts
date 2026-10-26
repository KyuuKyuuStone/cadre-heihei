/**
 * 台账仓储端口。
 *
 * `TaskLedgerPort` 是内存与 SQLite 实现共享的对外语义；
 * `LedgerTransaction` 供上层（派活/汇报）在同一事务内组合任务、消息与审计事件。
 */
import type { ProjectId, TaskId } from '../protocol/index.ts'
import type {
  CreateTaskCommand,
  CreateTaskOutcome,
  LedgerResult,
  TaskEvent,
  TaskRecord,
  TransitionCommand,
  TransitionOutcome,
} from './types.ts'

export interface TaskLedgerPort {
  createTask(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome>
  transition(command: TransitionCommand): LedgerResult<TransitionOutcome>
  getTask(projectId: ProjectId, taskId: TaskId): LedgerResult<TaskRecord>
  listTasks(projectId: ProjectId): readonly TaskRecord[]
  listEvents(projectId: ProjectId, taskId: TaskId): LedgerResult<readonly TaskEvent[]>
}

/**
 * 事务内台账操作：调用方已开启事务，实现**不得**再开启嵌套事务，
 * 也不读写台账级幂等表（幂等由上层组合操作统一负责）。
 */
export interface LedgerTransaction {
  createTask(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome>
  transition(command: TransitionCommand): LedgerResult<TransitionOutcome>
  getTask(projectId: ProjectId, taskId: TaskId): LedgerResult<TaskRecord>
  listTasks(projectId: ProjectId): readonly TaskRecord[]
  listEvents(projectId: ProjectId, taskId: TaskId): LedgerResult<readonly TaskEvent[]>
}
