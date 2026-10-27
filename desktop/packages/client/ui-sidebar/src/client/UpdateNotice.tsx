/** Non-blocking sidebar footer notice for a GitHub release or a one-time upgrade. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { cadreUpdateBridge, type CadreUpdateNotice } from './update-bridge.ts'
import css from './UpdateNotice.module.css'

/** Footer contribution props: the shell's collapsed flag plus sidebar copy. */
export type UpdateNoticeProps = { readonly wide: boolean } & PropsLocale<'sidebar'>

/**
 * Render the current notice. It never opens a modal and never blocks work;
 * dismissing the available notice leaves the one-time upgrade notice intact.
 * @param props - footer owner props and localized copy.
 * @returns the notice, a compact rail dot, or null.
 */
export function UpdateNotice({ wide, t }: UpdateNoticeProps) {
  const [notice, setNotice] = useState<CadreUpdateNotice | null>(null)
  const bridge = cadreUpdateBridge()

  useEffect(() => {
    if (bridge?.getUpdateNotice === undefined) return
    let active = true
    void bridge.getUpdateNotice()
      .then((next) => { if (active) setNotice(next) })
      .catch(() => undefined)
    const unsubscribe = bridge.subscribeUpdateNotice?.((next) => { if (active) setNotice(next) })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [bridge])

  if (notice === null) return null

  const dismiss = (): void => {
    void bridge?.dismissUpdateNotice?.(notice.kind)
      .then((next) => { setNotice(next) })
      .catch(() => undefined)
  }
  const open = (): void => {
    void bridge?.openReleasePage?.().catch(() => undefined)
  }

  if (!wide) {
    return (
      <button
        type="button"
        className={css.dot}
        title={notice.kind === 'available' ? `${t('update.available')} ${notice.version}` : t('update.upgraded')}
        aria-label={notice.kind === 'available' ? t('update.available') : t('update.upgraded')}
        onClick={notice.kind === 'available' ? open : dismiss}
      >
        {notice.kind === 'available' ? '●' : '!'}
      </button>
    )
  }

  if (notice.kind === 'upgraded') {
    return (
      <div className={css.notice} role="status">
        <span className={css.text} title={t('update.upgraded')}>{t('update.upgraded')}</span>
        <button type="button" className={css.close} onClick={dismiss} aria-label={t('update.dismiss')}>×</button>
      </div>
    )
  }

  return (
    <div className={css.notice} role="status">
      <span className={css.text}>{t('update.available')} {notice.version}</span>
      <button type="button" className={css.action} onClick={open}>{t('update.view')}</button>
      <button type="button" className={css.close} onClick={dismiss} aria-label={t('update.dismiss')}>×</button>
    </div>
  )
}
