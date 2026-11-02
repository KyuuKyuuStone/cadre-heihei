/** Simple install dialog: a URL uses install-url, a package name uses install-package. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { installSkillFromUrl, installSkillPackage } from './CadreSkills.tsx'
import css from './CadreSkillInstallDialog.module.css'

/** One paste-and-install surface; the advanced administrator conversation stays behind a link. */
export function CadreSkillInstallDialog({
  projectId, actorSessionId, onInstalled, openAdmin, onClose, t,
}: {
  readonly projectId: string
  readonly actorSessionId: string
  readonly onInstalled: () => Promise<void> | void
  readonly openAdmin: () => void
  readonly onClose: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const install = async (): Promise<void> => {
    const value = source.trim()
    if (value === '') {
      setError(t('skills.install.empty'))
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      if (/^https?:\/\//iu.test(value)) {
        await installSkillFromUrl(projectId, actorSessionId, value, false)
      } else {
        await installSkillPackage(projectId, actorSessionId, value)
      }
      setResult(t('skills.install.done', { source: value }))
      await onInstalled()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title={t('skills.install.title')}
      description={t('skills.install.description')} closeLabel={t('skills.close')}
      footer={<Button variant="outline" disabled={busy} onClick={onClose}>{t('skills.close')}</Button>}>
      <div className={css.body} data-skill-install-dialog>
        <label className={css.label}>{t('skills.install.source')}
          <textarea className={css.textarea} value={source} rows={4} disabled={busy}
            placeholder={t('skills.install.placeholder')}
            onChange={(event) => { setSource(event.target.value) }} />
        </label>
        <p className={css.hint}>{t('skills.install.hint')}</p>
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        {result !== null && <p className={css.notice} role="status">{result}</p>}
        <div className={css.actions}>
          <Button variant="primary" disabled={busy || source.trim() === ''} onClick={() => { void install() }}>
            {busy ? t('skills.install.busy') : t('skills.install.action')}
          </Button>
        </div>
        <details className={css.advanced}>
          <summary>{t('skills.install.advanced')}</summary>
          <p>{t('skills.install.advancedHint')}</p>
          <Button variant="ghost" size="sm" onClick={openAdmin}>{t('skills.install.openAdmin')}</Button>
        </details>
      </div>
    </Modal>
  )
}
