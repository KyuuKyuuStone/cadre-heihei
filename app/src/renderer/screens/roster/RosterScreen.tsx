import { useEffect, useState } from 'react'
import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useCadreApi } from '../../data/CadreApiProvider.tsx'
import { EMPTY_REASON_KEYS, failureToViewState } from '../../data/failureMapping.ts'
import type { RosterResponse } from '../../data/ipcContract.ts'
import { MEMBER_STATE_LABEL_KEYS, ROLE_LABEL_KEYS } from '../../data/labels.ts'
import type { ScopeSummary } from '../../../collab/protocol/roster.ts'
import { useLocale } from '../../i18n/LocaleProvider.tsx'

export function RosterScreen() {
  const api = useCadreApi()
  const { t } = useLocale()
  const [state, setState] = useState<ViewState<RosterResponse>>({ status: 'loading' })
  const [scope, setScope] = useState<ScopeSummary | null>(null)

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    void api.listRoster({ scope: 'project' }).then((res) => {
      if (!alive) return
      if (!res.ok) {
        setScope(null)
        setState(failureToViewState<RosterResponse>(res, { emptyHint: t('roster.empty.hint') }))
        return
      }
      setScope(res.scope)
      if (res.members.length === 0) {
        setState({
          status: 'empty',
          reason: res.scope.reason
            ? t(EMPTY_REASON_KEYS[res.scope.reason])
            : t('roster.empty.reason'),
          hint: res.scope.hint ?? t('roster.empty.hint'),
        })
        return
      }
      setState({ status: 'ready', data: res })
    })
    return () => {
      alive = false
    }
  }, [api, t])

  return (
    <section className="screen" data-screen="roster" aria-label={t('nav.roster')}>
      <h1 className="screen__title">{t('nav.roster')}</h1>

      {/* 双口径必须同屏且分开表述，避免被读成矛盾的「49 vs 0」。 */}
      <div className="roster-scope" data-testid="roster-scope">
        <span>{t('roster.scope.global', { n: scope?.globalCount ?? 0 })}</span>
        <span>{t('roster.scope.dispatchable', { n: scope?.dispatchableCount ?? 0 })}</span>
      </div>

      {scope && scope.globalCount > 0 && scope.dispatchableCount === 0 ? (
        <p className="hint" data-testid="roster-global-only-hint">{t('roster.globalOnlyHint')}</p>
      ) : null}

      <StateBoundary
        state={state}
        emptyTitle={t('roster.empty.title')}
        renderReady={(roster) => (
          <ul className="member-list" aria-label={t('nav.roster')}>
            {roster.members.map((member) => (
              <li key={member.sessionId} className="member-row" data-testid={`member-${member.sessionId}`}>
                <span className="member-row__name">{member.displayName}</span>
                <span className="member-row__muted">{t(ROLE_LABEL_KEYS[member.role])}</span>
                <span className="member-row__muted">{t(MEMBER_STATE_LABEL_KEYS[member.state])}</span>
                {member.dispatchable ? null : (
                  <span className="member-row__muted" data-testid={`member-${member.sessionId}-not-dispatchable`}>
                    {t('roster.notDispatchable')}
                    {member.dispatchableReason ? `: ${member.dispatchableReason}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      />
    </section>
  )
}
