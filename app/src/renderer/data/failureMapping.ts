/**
 * IPC `ApiFailure` → ViewState 八态映射（ADR-0020 / design/02 §2）。
 *
 * - `CROSS_PROJECT_DENIED` → denied（调用方负责清空数据）
 * - `TASK_NOT_FOUND`       → empty（不是错误）
 * - `INVALID_ARGUMENT`     → error + kind:'validation'（表单就地提示）
 * - 其余                   → error + kind:'system'
 */
import type { ApiFailure } from '../../collab/protocol/errors.ts'
import type { EmptyList, EmptyReason } from '../../collab/protocol/common.ts'
import type { TextKey } from '../i18n/index.ts'
import type { ViewState } from '../components/viewState.ts'

export type Translator = (key: TextKey, params?: Record<string, string | number>) => string

/** 协议空态 reason → 屏内文案。 */
export const EMPTY_REASON_KEYS: Record<EmptyReason, TextKey> = {
  no_projects: 'empty.reason.no_projects',
  no_workers_yet: 'empty.reason.no_workers_yet',
  no_workers_in_project: 'empty.reason.no_workers_in_project',
  project_not_matched: 'empty.reason.project_not_matched',
  no_tasks: 'empty.reason.no_tasks',
  no_tasks_for_filter: 'empty.reason.no_tasks_for_filter',
  no_messages: 'empty.reason.no_messages',
  no_candidates: 'empty.reason.no_candidates',
}

export interface FailureStateOptions {
  /** TASK_NOT_FOUND 等空结果的下一步提示。 */
  readonly emptyHint?: string
}

export function failureToViewState<T>(
  failure: ApiFailure,
  options: FailureStateOptions = {},
): ViewState<T> {
  const { code, message } = failure.error
  if (code === 'CROSS_PROJECT_DENIED') {
    return { status: 'denied', code, message }
  }
  if (code === 'TASK_NOT_FOUND') {
    return { status: 'empty', reason: message, hint: options.emptyHint ?? message }
  }
  if (code === 'INVALID_ARGUMENT') {
    const field = 'field' in failure.error
      ? (failure.error as { field?: string }).field
      : undefined
    return {
      status: 'error',
      kind: 'validation',
      code,
      message,
      retryable: false,
      field,
    }
  }
  return {
    status: 'error',
    kind: 'system',
    code,
    message,
    retryable: failure.error.retryable,
  }
}

/** 协议空列表 → empty 态；reason 走屏内文案，hint 用服务端给出的人话。 */
export function emptyListToViewState<T>(list: EmptyList<unknown>, t: Translator): ViewState<T> {
  const key = EMPTY_REASON_KEYS[list.reason] as TextKey | undefined
  return {
    status: 'empty',
    reason: key ? t(key) : String(list.reason),
    hint: list.hint,
  }
}

/** 表单验证错误（INVALID_ARGUMENT）单独取出，供筛选区/发送框就地展示。 */
export function isValidationError<T>(
  state: ViewState<T>,
): state is Extract<ViewState<T>, { status: 'error' }> {
  return state.status === 'error' && state.kind === 'validation'
}
