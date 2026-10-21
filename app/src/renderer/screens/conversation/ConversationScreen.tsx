import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useTranslation } from '../../i18n/LocaleProvider.tsx'

/** 首版空态骨架：数据接线（IPC）在后续任务完成。 */
export function ConversationScreen() {
  const t = useTranslation()
  const state: ViewState<null> = {
    status: 'empty',
    reason: t('conversation.empty.reason'),
    hint: t('conversation.empty.hint'),
  }

  return (
    <section className="screen" data-screen="conversation" aria-label={t('nav.conversation')}>
      <h1 className="screen__title">{t('nav.conversation')}</h1>
      <StateBoundary
        state={state}
        emptyTitle={t('conversation.empty.title')}
        renderReady={() => null}
      />
    </section>
  )
}
