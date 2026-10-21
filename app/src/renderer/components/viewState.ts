/**
 * 首版八态判别联合（ADR-0020 / design/02 §2）。
 * empty 是合法初始态，类型上强制携带 reason + hint（02 铁律 11），
 * 调用方不得用 error 表达「还没有内容」。
 */
export type ViewState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'empty'; reason: string; hint: string }
  | { status: 'error'; message: string; code?: string; retryable?: boolean }
  | { status: 'denied'; message: string; code?: string }
  | {
    status: 'truncated'
    data: T
    truncated: { totalLines: number; shownLines: number; outputFile?: string }
  }
  | { status: 'streaming'; data: T; messageId?: string }
