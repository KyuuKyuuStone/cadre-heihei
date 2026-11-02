/** Skill-admin entry: ordinary conversation history, create/delete, and open in the main chat. */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSkillAdminSession,
  deleteSkillAdminSession,
  listSkillAdminSessions,
  SkillAdminError,
  skillAdminErrorKey,
  type SkillAdminSession,
} from './CadreSkillAdmin.ts'
import css from './CadreSkillAdminDialog.module.css'

/** Modal listing this supervisor's ordinary skill-admin conversations. */
export function CadreSkillAdminDialog({
  projectId, operatorSessionId, openSession, onClose, t,
}: {
  readonly projectId: string
  readonly operatorSessionId: string
  readonly openSession: (sessionId: string) => Promise<void>
  readonly onClose: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [sessions, setSessions] = useState<readonly SkillAdminSession[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSessions(await listSkillAdminSessions(projectId))
    } catch (cause) {
      setError(cause instanceof SkillAdminError
        ? t(skillAdminErrorKey(cause.code) as never)
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [operatorSessionId, projectId, t])

  useEffect(() => { void load() }, [load])

  const open = async (sessionId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await openSession(sessionId)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await createSkillAdminSession(projectId)
      setSessions(current => [created, ...current])
      await open(created.sessionId)
    } catch (cause) {
      setError(cause instanceof SkillAdminError
        ? t(skillAdminErrorKey(cause.code) as never)
        : cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const remove = async (sessionId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await deleteSkillAdminSession(projectId, operatorSessionId, sessionId)
      setSessions(current => current.filter(session => session.sessionId !== sessionId))
    } catch (cause) {
      setError(cause instanceof SkillAdminError
        ? t(skillAdminErrorKey(cause.code) as never)
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={t('skills.admin.title')}
      description={t('skills.admin.description')}
      closeLabel={t('skills.close')}
      footer={<Button variant="outline" onClick={onClose} disabled={busy}>{t('skills.close')}</Button>}
    >
      <div className={css.body}>
        <p className={css.hint}>{t('skills.admin.openHint')}</p>
        <div className={css.toolbar}>
          <Button variant="primary" disabled={busy} onClick={() => { void create() }}>{t('skills.admin.new')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { void load() }}>{t('skills.admin.refresh')}</Button>
        </div>
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        {busy && sessions.length === 0 && <p className={css.hint}>{t('skills.admin.loading')}</p>}
        {!busy && sessions.length === 0 && <p className={css.hint}>{t('skills.admin.empty')}</p>}
        {sessions.length > 0 && (
          <ul className={css.list}>
            {sessions.map(session => (
              <li key={session.sessionId} className={css.row}>
                <button type="button" className={css.open} disabled={busy} onClick={() => { void open(session.sessionId) }}>
                  <span className={css.rowTitle}>{session.title || t('skills.admin.untitled')}</span>
                  <span className={css.rowMeta}>{new Date(session.updatedAt).toLocaleString()}</span>
                </button>
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => { void remove(session.sessionId) }}>{t('skills.admin.delete')}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
