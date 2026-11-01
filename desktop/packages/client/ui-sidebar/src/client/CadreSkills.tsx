/**
 * Supervisor skill-pack picker. Host routes are supervisor-only; the API key /
 * session content never passes through this file.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState, CadreSessionsState } from './CadreSidebar.tsx'
import css from './CadreSkills.module.css'

type UseMenuOpenState = () => readonly [open: boolean, setOpen: (open: boolean) => void]

export interface CadreSkillEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly roles: readonly string[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly selected: boolean
}

export interface CadreSkillPreview {
  readonly id: string
  readonly content: string
  readonly tokenEstimate: number
  readonly license: string
}

export interface CadreSkillsRequest {
  readonly sessionId: string
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
  openSkills(sessionId: string, label: string, role: 'supervisor' | 'worker'): void
  closeSkills(): void
}

interface SkillResponse {
  readonly ok?: boolean
  readonly result?: unknown
  readonly code?: string
  readonly message?: string
}

async function skillCall(
  method: 'catalog' | 'set' | 'preview' | 'add' | 'remove',
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
  projectId: string, actorSessionId: string, targetSessionId?: string,
): Promise<CadreSkillEntry[]> {
  const result = await skillCall('catalog', {
    projectId, actorSessionId, ...(targetSessionId === undefined ? {} : { targetSessionId }),
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
  const activeSessionId = useSessions(state => Object.entries(state.byId)
    .find(([, session]) => (session?.retainedBy?.mainView ?? 0) > 0)?.[0])
  const actor = members.find(item => item.sessionId === activeSessionId)
  const member = members.find(item => item.sessionId === sessionId)
  if (actor?.role !== 'supervisor' || member === undefined || member.state === 'departed') return null
  return (
    <button type="button" role="menuitem" className={css.menuItem}
      onClick={() => {
        setMenuOpen(false)
        openSkills(sessionId, displayTitle, member.role === 'supervisor' ? 'supervisor' : 'worker')
      }}>
      {t('skills.menu')}
    </button>
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
  const [adding, setAdding] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [manual, setManual] = useState({
    id: '', name: '', description: '', role: request.role,
    tokenEstimate: '', tools: 'read, read_image, grep', source: 'manual', license: 'MIT', content: '',
  })
  const [tokenManual, setTokenManual] = useState(false)
  const projectId = request.projectId

  const load = useCallback(async (selectId?: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = (await fetchSkillCatalog(request.projectId, request.sessionId, request.sessionId))
        .filter(entry => entry.roles.includes(request.role))
      setEntries(next)
      setSelected(next.filter(entry => entry.selected || entry.id === selectId).map(entry => entry.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [request.projectId, request.sessionId, request.role])

  useEffect(() => { void load() }, [load])

  const toggle = (id: string): void => {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const openPreview = async (id: string): Promise<void> => {
    setError(null)
    try {
      setPreview(await previewSkill(projectId, request.sessionId, id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveMemberSkills(projectId, request.sessionId, request.sessionId, selected)
      setNotice(t('skills.notice.saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('skills.confirmRemove', { id }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await skillCall('remove', {
        projectId,
        actorSessionId: request.sessionId,
        packId: id,
        confirm: true,
      })
      setSelected(current => current.filter(item => item !== id))
      await load()
      setNotice(t('skills.notice.removed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openManual = (): void => {
    setManual({
      id: '', name: '', description: '', role: request.role,
      tokenEstimate: '', tools: 'read, read_image, grep', source: 'manual', license: 'MIT', content: '',
    })
    setTokenManual(false)
    setOverwrite(false)
    setAdding(true)
    setError(null)
    setNotice(null)
  }

  const add = async (): Promise<void> => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manual.id) || manual.id.length > 64) {
      setError(t('skills.error.id'))
      return
    }
    if (manual.name.trim() === '' || manual.description.trim() === '' || manual.license.trim() === '' || manual.source.trim() === '') {
      setError(t('skills.error.required'))
      return
    }
    if (!/^\d+$/u.test(manual.tokenEstimate)) {
      setError(t('skills.error.tokens'))
      return
    }
    if (manual.content.trim() === '') {
      setError(t('skills.error.content'))
      return
    }
    if (entries.some(entry => entry.id === manual.id) && !overwrite) {
      setError(t('skills.error.exists'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await skillCall('add', {
        projectId,
        actorSessionId: request.sessionId,
        ...manual,
        roles: [manual.role],
        tokenEstimate: Number(manual.tokenEstimate),
        tools: manual.tools.split(',').map(item => item.trim()).filter(item => item !== ''),
        overwrite,
      })
      await load(manual.id)
      setAdding(false)
      setNotice(t('skills.notice.added'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

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
      <div className={css.addBar}>
        <p className={css.total}>{t('skills.total', { count: String(skillTokenTotal(entries, selected)) })}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={openManual}>{t('skills.add')}</Button>
      </div>
      {adding && (
        <div className={css.manual} data-skill-manual>
          <label className={css.field}>{t('skills.field.id')}
            <Input value={manual.id} disabled={busy} onChange={(event) => { setManual({ ...manual, id: event.target.value.trim() }) }} />
          </label>
          <label className={css.field}>{t('skills.field.name')}
            <Input value={manual.name} disabled={busy} onChange={(event) => { setManual({ ...manual, name: event.target.value }) }} />
          </label>
          <label className={css.field}>{t('skills.field.description')}
            <Input value={manual.description} disabled={busy}
              onChange={(event) => { setManual({ ...manual, description: event.target.value }) }} />
          </label>
          <label className={css.field}>{t('skills.field.role')}
            <select className={css.select} value={manual.role} disabled={busy}
              onChange={(event) => { setManual({ ...manual, role: event.target.value as 'supervisor' | 'worker' }) }}>
              <option value="worker">{t('skills.role.worker')}</option>
              <option value="supervisor">{t('skills.role.supervisor')}</option>
            </select>
          </label>
          <label className={css.field}>{t('skills.field.tokens')}
            <Input type="number" min={0} value={manual.tokenEstimate} disabled={busy}
              onChange={(event) => { setTokenManual(true); setManual({ ...manual, tokenEstimate: event.target.value }) }} />
          </label>
          <label className={css.field}>{t('skills.field.tools')}
            <Input value={manual.tools} disabled={busy} onChange={(event) => { setManual({ ...manual, tools: event.target.value }) }} />
          </label>
          <label className={css.field}>{t('skills.field.source')}
            <Input value={manual.source} disabled={busy} onChange={(event) => { setManual({ ...manual, source: event.target.value }) }} />
          </label>
          <label className={css.field}>{t('skills.field.license')}
            <Input value={manual.license} disabled={busy} onChange={(event) => { setManual({ ...manual, license: event.target.value }) }} />
          </label>
          <div className={css.field}>
            <span>{t('skills.field.content')}</span>
            <input className={css.file} type="file" multiple disabled={busy}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              aria-label={t('skills.importFile')}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                const body = files.find(file => file.name.toLowerCase() === 'skill.md')
                if (body === undefined) {
                  setError(t('skills.error.file'))
                  return
                }
                const manifestFile = files.find(file => file.name.toLowerCase() === 'manifest.json')
                void (async () => {
                  let manifest: Record<string, unknown> = {}
                  if (manifestFile !== undefined) {
                    try {
                      manifest = JSON.parse(await manifestFile.text()) as Record<string, unknown>
                    } catch { /* keep the manually entered metadata */ }
                  }
                  const text = await body.text()
                  const manifestTokens = typeof manifest.tokenEstimate === 'number'
                    ? String(Math.max(0, Math.round(manifest.tokenEstimate))) : undefined
                  const manifestTools = Array.isArray(manifest.tools)
                    ? manifest.tools.filter((item): item is string => typeof item === 'string').join(', ') : undefined
                  const manifestRoles = Array.isArray(manifest.roles)
                    ? manifest.roles.filter((item): item is string => item === 'worker' || item === 'supervisor') : []
                  setManual(current => ({
                    ...current,
                    content: text,
                    ...(tokenManual ? {} : { tokenEstimate: manifestTokens ?? String(Math.ceil(text.length / 4)) }),
                    ...(typeof manifest.id === 'string' ? { id: manifest.id } : {}),
                    ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
                    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
                    ...(typeof manifest.source === 'string' ? { source: manifest.source } : {}),
                    ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
                    ...(manifestTools === undefined ? {} : { tools: manifestTools }),
                    ...(manifestRoles.includes(request.role) ? { role: request.role }
                      : manifestRoles[0] === 'supervisor' || manifestRoles[0] === 'worker' ? { role: manifestRoles[0] } : {}),
                  }))
                })()
              }} />
            <textarea className={css.textarea} value={manual.content} rows={7} disabled={busy}
              placeholder={t('skills.field.contentPlaceholder')}
              onChange={(event) => {
                const text = event.target.value
                setManual(current => ({
                  ...current,
                  content: text,
                  ...(tokenManual ? {} : { tokenEstimate: String(Math.ceil(text.length / 4)) }),
                }))
              }} />
          </div>
          <Checkbox checked={overwrite} label={t('skills.overwrite')} disabled={busy} onChange={setOverwrite} />
          <div className={css.footer}>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setAdding(false) }}>{t('skills.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void add() }}>{t('skills.addSave')}</Button>
          </div>
        </div>
      )}
      <CadreSkillPicker entries={entries} selected={selected} onToggle={toggle}
        onPreview={(id) => { void openPreview(id) }} onRemove={(id) => { void remove(id) }} t={t} />
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      {preview !== null && (
        <div className={css.preview} data-skill-preview>
          <div className={css.previewHead}>
            <strong>{preview.id}</strong>
            <span>{t('skills.tokenEstimate', { count: String(preview.tokenEstimate) })} · {preview.license}</span>
            <Button variant="ghost" size="sm" onClick={() => { setPreview(null) }}>{t('skills.closePreview')}</Button>
          </div>
          <pre className={css.previewBody}>{preview.content}</pre>
        </div>
      )}
    </Modal>
  )
}
