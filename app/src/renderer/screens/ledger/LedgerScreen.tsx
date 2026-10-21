import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useTranslation } from '../../i18n/LocaleProvider.tsx'

/** 首版空态骨架：台账数据（IPC/摘要查询）在后续任务完成。 */
export function LedgerScreen() {
  const t = useTranslation()
  const state: ViewState<null> = {
    status: 'empty',
    reason: t('ledger.empty.reason'),
    hint: t('ledger.empty.hint'),
  }

  return (
    <section className="screen" data-screen="ledger" aria-label={t('nav.ledger')}>
      <h1 className="screen__title">{t('nav.ledger')}</h1>
      <StateBoundary
        state={state}
        emptyTitle={t('ledger.empty.title')}
        renderReady={() => null}
      />
    </section>
  )
}
