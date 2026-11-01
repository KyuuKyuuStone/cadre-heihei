/**
 * Supervisor skill-pack picker. Host routes are supervisor-only; the API key /
 * session content never passes through this file.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, IconAgentPresetOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import css from './CadreSkills.module.css'

type UseMenuOpenState = () => readonly [open: boolean, setOpen: (open: boolean) => void]

export interface CadreSkillEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly origin?: 'builtin' | 'installed'
  readonly roles: readonly string[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  /** Optional upstream homepage and author metadata. */
  readonly homepage?: string
  readonly author?: string
  readonly selected: boolean
}

export interface CadreSkillPreview {
  readonly id: string
  readonly content: string
  readonly tokenEstimate: number
  readonly license: string
}

export interface CadreSkillsRequest {
  /** Target member whose selection is edited. */
  readonly sessionId: string
  /** Current supervisor acting on the target. */
  readonly actorSessionId: string
  readonly projectId: string
  readonly label: string
  readonly role: 'supervisor' | 'worker'
  readonly token: number
}

export interface CadreSkillsInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    sessions: HostObservable<CadreSessionsState>
    request: HostObservable<CadreSkillsRequest | null>
  }
  openSkills(
    sessionId: string,
    label: string,
    role: 'supervisor' | 'worker',
    actorSessionId: string,
  ): void
  closeSkills(): void
}

interface SkillResponse {
  readonly ok?: boolean
  readonly result?: unknown
  readonly code?: string
  readonly message?: string
}

async function skillCall(
  method: 'catalog' | 'set' | 'preview' | 'add' | 'remove' | 'install-url',
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`/cadre/skills/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json() as SkillResponse
  if (!response.ok || result.ok !== true) {
    throw new Error(result.code === undefined
      ? (result.message ?? `HTTP ${String(response.status)}`)
      : `${result.code} · ${result.message ?? '请求失败'}`)
  }
  return result.result
}

export async function fetchSkillCatalog(
  projectId: string, actorSessionId: string, targetSessionId?: string, locale?: string,
): Promise<CadreSkillEntry[]> {
  const result = await skillCall('catalog', {
    projectId, actorSessionId,
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
    ...(locale === undefined ? {} : { locale }),
  })
  return Array.isArray(result) ? result as CadreSkillEntry[] : []
}

export async function saveMemberSkills(
  projectId: string, actorSessionId: string, targetSessionId: string, skills: readonly string[],
): Promise<void> {
  await skillCall('set', { projectId, actorSessionId, targetSessionId, skills })
}

export async function previewSkill(
  projectId: string, actorSessionId: string, packId: string,
): Promise<CadreSkillPreview> {
  return await skillCall('preview', { projectId, actorSessionId, packId }) as CadreSkillPreview
}

export async function addSkillToLibrary(
  projectId: string, actorSessionId: string, pack: Record<string, unknown>,
): Promise<void> {
  await skillCall('add', { projectId, actorSessionId, ...pack })
}

export async function removeSkillFromLibrary(
  projectId: string, actorSessionId: string, packId: string,
): Promise<void> {
  await skillCall('remove', { projectId, actorSessionId, packId, confirm: true })
}

export async function installSkillFromUrl(
  projectId: string, actorSessionId: string, url: string, confirm: boolean,
): Promise<void> {
  await skillCall('install-url', { projectId, actorSessionId, url, confirm })
}

export function skillTokenTotal(entries: readonly CadreSkillEntry[], selected: readonly string[]): number {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  return selected.reduce((total, id) => total + (byId.get(id)?.tokenEstimate ?? 0), 0)
}

/** Controlled checkbox list used by both the create dialog and the editor. */
export function CadreSkillPicker({
  entries, selected, onToggle, onPreview, onRemove, t,
}: {
  readonly entries: readonly CadreSkillEntry[]
  readonly selected: readonly string[]
  readonly onToggle: (id: string) => void
  readonly onPreview: (id: string) => void
  readonly onRemove?: (id: string) => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  if (entries.length === 0) {
    return (
      <div className={css.empty}>
        <p>{t('skills.empty')}</p>
        <code>{t('skills.installDir')}</code>
      </div>
    )
  }
  return (
    <ul className={css.list}>
      {entries.map(entry => (
        <li key={entry.id} className={css.entry}>
          <Checkbox
            checked={selected.includes(entry.id)}
            label={entry.name}
            onChange={() => { onToggle(entry.id) }}
          />
          <p className={css.description}>{entry.description}</p>
          <div className={css.meta}>
            <span>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
            <span>{entry.license}</span>
            <Button variant="ghost" size="sm" onClick={() => { onPreview(entry.id) }}>{t('skills.preview')}</Button>
            {onRemove !== undefined && (
              <Button variant="ghost" size="sm" onClick={() => { onRemove(entry.id) }}>{t('skills.remove')}</Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CadreSkillSettingsMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, useSessions, openSkills, t,
}: { readonly sessionId: string; readonly displayTitle: string } & {
  readonly useMenuOpenState: UseMenuOpenState
} & InjectFace<CadreSkillsInjected> & PropsLocale<'sidebar'>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const activeContext = useSessions((state) => {
    const active = Object.entries(state.byId)
      .filter(([, session]) => (session?.retainedBy?.mainView ?? 0) > 0)
      .map(([id]) => id)
    const supervisor = active.find(id => members.some(item => item.sessionId === id && item.role === 'supervisor'))
    if (supervisor !== undefined) return `supervisor:${supervisor}`
    return active[0] === undefined ? 'none' : `active:${active[0]}`
  })
  // Retention order is not identity: during a navigation handoff both the old
  // and new Session can be retained. Resolve the acting supervisor from the
  // retained set, not from whichever id happens to come first. With no active
  // Session (the skill/team panel is showing), a sole supervisor still owns the
  // roster controls; an active non-roster/ordinary Session hides them.
  const activeId = activeContext.startsWith('supervisor:') ? activeContext.slice('supervisor:'.length) : undefined
  const soleSupervisor = members.filter(item => item.role === 'supervisor' && item.state !== 'departed')
  const actor = activeId !== undefined
    ? members.find(item => item.sessionId === activeId)
    : activeContext === 'none' && soleSupervisor.length === 1 ? soleSupervisor[0] : undefined
  const member = members.find(item => item.sessionId === sessionId)
  if (actor === undefined || member === undefined || member.state === 'departed') return null
  return (
    <MenuItemButton
      icon={<IconAgentPresetOutlineRegular />}
      separatorBefore
      onSelect={() => {
        setMenuOpen(false)
        openSkills(
          sessionId,
          displayTitle,
          member.role === 'supervisor' ? 'supervisor' : 'worker',
          actor.sessionId,
        )
      }}
    >
      {t('skills.menu')}
    </MenuItemButton>
  )
}

export function CadreSkillSettingsDialog({
  useRequest, closeSkills, t,
}: InjectFace<CadreSkillsInjected> & PropsLocale<'sidebar'>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return <SkillEditor key={request.token} request={request} onClose={closeSkills} t={t} />
}

function SkillEditor({
  request, onClose, t,
}: {
  readonly request: CadreSkillsRequest
  readonly onClose: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [preview, setPreview] = useState<CadreSkillPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const projectId = request.projectId

  const load = useCallback(async (selectId?: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = (await fetchSkillCatalog(
        request.projectId,
        request.actorSessionId,
        request.sessionId,
        navigator.language,
      )).filter(entry => entry.roles.includes(request.role))
      setEntries(next)
      setSelected(next.filter(entry => entry.selected || entry.id === selectId).map(entry => entry.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [request.projectId, request.actorSessionId, request.sessionId, request.role])

  useEffect(() => { void load() }, [load])

  const toggle = (id: string): void => {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const openPreview = async (id: string): Promise<void> => {
    setError(null)
    try {
      setPreview(await previewSkill(projectId, request.actorSessionId, id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveMemberSkills(projectId, request.actorSessionId, request.sessionId, selected)
      setNotice(t('skills.notice.saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const previewEntry = preview === null ? undefined : entries.find(entry => entry.id === preview.id)
  const previewSource = previewEntry?.homepage?.trim() || previewEntry?.source.trim() || ''

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={t('skills.title', { label: request.label })}
      description={t('skills.description')}
      closeLabel={t('skills.close')}
      className={css.dialog ?? ''}
      contentClassName={css.content ?? ''}
      footer={(
        <div className={css.footer}>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('skills.close')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('skills.save')}</Button>
        </div>
      )}
    >
      <p className={css.total}>{t('skills.total', { count: String(skillTokenTotal(entries, selected)) })}</p>
      <CadreSkillPicker entries={entries} selected={selected} onToggle={toggle}
        onPreview={(id) => { void openPreview(id) }} t={t} />
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      {preview !== null && (
        <div className={css.preview} data-skill-preview>
          <div className={css.previewHead}>
            <strong>{preview.id}</strong>
            <span>{t('skills.tokenEstimate', { count: String(preview.tokenEstimate) })}</span>
            <span>{t('skills.licenseLabel', { license: preview.license })}</span>
            {previewEntry?.author !== undefined && previewEntry.author.trim() !== '' && (
              <span>{t('skills.author', { author: previewEntry.author })}</span>
            )}
            {/^https?:\/\//iu.test(previewSource)
              ? <a href={previewSource} target="_blank" rel="noopener noreferrer">{t('skills.upstream')}</a>
              : previewSource !== '' ? <span>{previewSource}</span> : null}
            <Button variant="ghost" size="sm" onClick={() => { setPreview(null) }}>{t('skills.closePreview')}</Button>
          </div>
          <pre className={css.previewBody}>{preview.content}</pre>
        </div>
      )}
    </Modal>
  )
}
