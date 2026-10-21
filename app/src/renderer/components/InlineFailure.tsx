import type { ViewState } from './viewState.ts'

/** 表单/面板内联错误：denied 用拒绝样式，其余就地提示（不做整屏替换）。 */
export function InlineFailure({
  state,
  testId,
}: {
  state: ViewState<unknown> | null
  testId?: string
}) {
  if (!state) return null
  if (state.status === 'denied') {
    return (
      <div className="state state--denied" role="alert" data-testid={testId}>
        <p className="state__reason">{state.message}</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <p className="form-error" role="alert" data-testid={testId}>
        {state.message}
        {state.code ? <code className="state__code">{state.code}</code> : null}
      </p>
    )
  }
  if (state.status === 'empty') {
    return (
      <p className="hint" data-testid={testId}>
        {state.reason} {state.hint}
      </p>
    )
  }
  return null
}
