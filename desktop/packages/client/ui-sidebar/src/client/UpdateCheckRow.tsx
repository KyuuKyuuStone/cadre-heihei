/** General-settings row for the GitHub Releases check preference. */
import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { cadreUpdateBridge } from './update-bridge.ts'
import css from './UpdateCheckRow.module.css'

/** The row is hidden in shells that do not expose the desktop update bridge. */
export function UpdateCheckRow({ t }: PropsLocale<'sidebar'>) {
  const bridge = cadreUpdateBridge()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (bridge?.getUpdateCheckEnabled === undefined) return
    let active = true
    void bridge.getUpdateCheckEnabled()
      .then((value) => { if (active) setEnabled(value) })
      .catch(() => undefined)
    return () => { active = false }
  }, [bridge])

  if (enabled === null) return null

  const change = (next: boolean): void => {
    const set = bridge?.setUpdateCheckEnabled
    if (set === undefined) return
    setBusy(true)
    setError(false)
    void set(next)
      .then((value) => { setEnabled(value) })
      .catch(() => { setError(true) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{t('update.settings.title')}</div>
        <div className={css.description}>{t('update.settings.description')}</div>
        {error && <div className={css.error} role="alert">{t('update.settings.saveFailed')}</div>}
      </div>
      <Switch
        checked={enabled}
        label={t('update.settings.label')}
        disabled={busy}
        onChange={change}
      />
    </div>
  )
}
