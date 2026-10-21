import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useTranslation } from '../../i18n/LocaleProvider.tsx'

/** 首版空态骨架：双口径计数与员工列表在后续任务接 IPC。 */
const GLOBAL_REGISTERED = 0
const DISPATCHABLE = 0

export function RosterScreen() {
  const t = useTranslation()
  const state: ViewState<null> = {
    status: 'empty',
    reason: t('roster.empty.reason'),
    hint: t('roster.empty.hint'),
  }

  return (
    <section className="screen" data-screen="roster" aria-label={t('nav.roster')}>
      <h1 className="screen__title">{t('nav.roster')}</h1>
      {/* 双口径必须同屏且分开表述，避免被读成矛盾的「49 vs 0」。 */}
      <div className="roster-scope" data-testid="roster-scope">
        <span>{t('roster.scope.global', { n: GLOBAL_REGISTERED })}</span>
        <span>{t('roster.scope.dispatchable', { n: DISPATCHABLE })}</span>
      </div>
      <StateBoundary
        state={state}
        emptyTitle={t('roster.empty.title')}
        renderReady={() => null}
      />
    </section>
  )
}
