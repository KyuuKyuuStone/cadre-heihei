import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/LocaleProvider.tsx'
import type { ViewState } from './viewState.ts'

type Props<T> = {
  state: ViewState<T>
  renderReady: (data: T) => ReactNode
  /** 空态标题；缺省用通用「暂无内容」。 */
  emptyTitle?: string
  onRetry?: () => void
  /** truncated 态的动作：展开全文（A-F2）或加载更多（台账）。 */
  onExpand?: () => void
  expandLabel?: string
}

/**
 * 八态分流。按 design/02 §2 的三组呈现：
 *   进行中（idle/loading/streaming）—— 中性色，不拦截内容；
 *   就绪（ready/truncated）—— 内容 + 截断标记；
 *   受阻（empty/error/denied）—— empty 用中性空态，绝不使用错误色。
 */
export function StateBoundary<T>({
  state,
  renderReady,
  emptyTitle,
  onRetry,
  onExpand,
  expandLabel,
}: Props<T>) {
  const t = useTranslation()

  switch (state.status) {
    case 'idle':
    case 'loading':
      return (
        <div className="state state--progress" role="status" data-state={state.status}>
          {t('state.loading')}
        </div>
      )

    case 'streaming':
      return (
        <div className="state--ready" data-state="streaming">
          {renderReady(state.data)}
          <div className="state state--progress" role="status">
            {t('state.streaming')}
          </div>
        </div>
      )

    case 'ready':
      return <div className="state--ready" data-state="ready">{renderReady(state.data)}</div>

    case 'truncated': {
      const isItems = state.truncated.unit === 'items'
      const n = isItems ? state.truncated.shownLines : state.truncated.totalLines
      return (
        <div className="state--ready" data-state="truncated">
          {renderReady(state.data)}
          <div className="state-truncated" role="status">
            <span>{t(isItems ? 'state.truncatedItems' : 'state.truncated', { n })}</span>
            {state.truncated.outputFile ? <code>{state.truncated.outputFile}</code> : null}
            {onExpand ? (
              <button type="button" className="button button--ghost" onClick={onExpand}>
                {expandLabel ?? t('state.expandFull')}
              </button>
            ) : null}
          </div>
        </div>
      )
    }

    case 'empty':
      return (
        <div className="state state--empty" role="status" data-state="empty">
          <h2 className="state__title">{emptyTitle ?? t('state.empty')}</h2>
          <p className="state__reason">{state.reason}</p>
          <p className="state__hint">{state.hint}</p>
        </div>
      )

    case 'error':
      return (
        <div className="state state--error" role="alert" data-state="error">
          <h2 className="state__title">{t('state.error')}</h2>
          <p className="state__reason">{state.message}</p>
          {state.code ? <code className="state__code">{state.code}</code> : null}
          {onRetry ? (
            <button type="button" className="button" onClick={onRetry}>
              {t('state.retry')}
            </button>
          ) : null}
        </div>
      )

    case 'denied':
      return (
        <div className="state state--denied" role="alert" data-state="denied">
          <h2 className="state__title">{t('state.denied')}</h2>
          <p className="state__reason">{state.message}</p>
          {state.code ? <code className="state__code">{state.code}</code> : null}
        </div>
      )
  }
}
