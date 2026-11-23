/** Per-conversation skill selection page, opened from the Conversation view tabs. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import {
  fetchSkillCatalog,
  previewSkill,
  saveMemberSkills,
  skillTokenTotal,
  type CadreSkillEntry,
  type CadreSkillPreview,
} from './CadreSkills.tsx'
import css from './CadreSkillTab.module.css'

export interface CadreSkillTabInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
  projectOfSession(sessionId: string): string | undefined
  defaultProjectId(): string | undefined
}

type SkillTabProps = {
  readonly sessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
} & InjectFace<CadreSkillTabInjected>

/** Internal filter key for untagged packs; never matched against tag data. */
const UNCATEGORIZED_FILTER = '__uncategorized__'
const BUILTIN_SOURCES = /^(builtin|internal|cadre)$/iu
const isBuiltin = (entry: CadreSkillEntry): boolean =>
  entry.origin === 'builtin' || (entry.origin === undefined && BUILTIN_SOURCES.test(entry.source.trim()))

/** One Session's skill catalog, editable only by that Session's roster member. */
export function CadreSkillTab({ sessionId, useRoster, projectOfSession, defaultProjectId, t }: SkillTabProps) {
  const { members, status: rosterStatus, error: rosterError } = useRoster(state => state)
  const member = members.find(item => item.sessionId === sessionId)
  const projectId = projectOfSession(sessionId) ?? defaultProjectId()
  const [entries, setEntries] = useState<readonly CadreSkillEntry[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [preview, setPreview] = useState<CadreSkillPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (projectId === undefined || (member === undefined && rosterStatus !== 'ready')) return
    const request = ++requestVersion.current
    setBusy(true)
    setError(null)
    try {
      const catalog = await fetchSkillCatalog(
        projectId, sessionId, member === undefined ? undefined : sessionId, navigator.language, t,
      )
      if (request !== requestVersion.current) return
      const next = member === undefined ? catalog : catalog.filter(entry => entry.roles.includes(member.role))
      setEntries(next)
      setSelected(next.filter(entry => entry.selected).map(entry => entry.id))
    } catch (cause) {
      if (request === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === requestVersion.current) setBusy(false)
    }
  }, [member, projectId, rosterStatus, sessionId, t])

  useEffect(() => {
    void load()
    return () => { requestVersion.current += 1 }
  }, [load])

  if (member?.state === 'departed') return null
  if (member === undefined && rosterStatus !== 'ready') {
    if (rosterStatus === 'error' && rosterError !== null) {
      return <section className={css.page}><p className={css.error} role="alert">{rosterError}</p></section>
    }
    return null
  }
  if (projectId === undefined) {
    return <section className={css.page}><p className={css.error} role="alert">{t('skills.tab.noProject')}</p></section>
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveMemberSkills(projectId, sessionId, sessionId, selected, t)
      setNotice(t('skills.tab.saved'))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={css.page} data-cadre-skill-tab>
      <header className={css.header}>
        <div>
          <h1>{t('skills.tab.title')}</h1>
          <p>{t('skills.tab.description')}</p>
        </div>
      </header>
      <div className={css.summary}>
        <span className={css.count}>{t('skills.tab.count', { count: String(selected.length) })}</span>
        <span className={css.total}>{t('skills.total', { count: String(skillTokenTotal(entries, selected)) })}</span>
      </div>
      <div className={css.filters} data-skill-tab-filters>
        <Input
          value={query}
          placeholder={t('skills.search.placeholder')}
          aria-label={t('skills.search.placeholder')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      {(() => {
        const categories = [...new Set(entries.flatMap(entry => entry.categories ?? []))]
        const uncategorizedCount = entries.filter(entry => (entry.categories ?? []).length === 0).length
        if (categories.length === 0 && uncategorizedCount === 0) return null
        const categoryCard = (key: string, label: string, count: number) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={categoryFilter === key}
            className={categoryFilter === key ? `${css.categoryCard} ${css.categoryCardSelected}` : css.categoryCard}
            onClick={() => { setCategoryFilter(key) }}
          >
            <span className={css.categoryCardName}>{label}</span>
            {' '}
            <span className={css.categoryCardCount}>{count}</span>
          </button>
        )
        return (
          <div className={css.categoryRow} data-skill-category-row>
            <span className={css.categoryLabel}>{t('skills.filter.categoryLabel')}</span>
            <div className={css.categoryCards} role="radiogroup" aria-label={t('skills.filter.category')} data-skill-category-cards>
              {categoryCard('all', t('skills.filter.all'), entries.length)}
              {categories.map(category => categoryCard(category, category, entries.filter(entry => (entry.categories ?? []).includes(category)).length))}
              {uncategorizedCount > 0 && categoryCard(UNCATEGORIZED_FILTER, t('skills.group.uncategorized'), uncategorizedCount)}
            </div>
          </div>
        )
      })()}
      {entries.length === 0
        ? <div className={css.empty} data-skill-tab-empty><span aria-hidden="true">✦</span><p>{t('skills.empty')}</p></div>
        : (() => {
          const needle = query.trim().toLowerCase()
          const visible = entries.filter(entry => {
            if (categoryFilter === UNCATEGORIZED_FILTER && (entry.categories ?? []).length > 0) return false
            if (categoryFilter !== 'all' && categoryFilter !== UNCATEGORIZED_FILTER && !(entry.categories ?? []).includes(categoryFilter)) return false
            if (needle === '') return true
            return `${entry.name}\n${entry.id}\n${entry.description}`.toLowerCase().includes(needle)
          })
          return visible.length === 0
            ? <div className={css.empty} data-skill-tab-no-match><span aria-hidden="true">✦</span><p>{t('skills.search.noMatch')}</p></div>
            : <ul className={css.cards}>
          {visible.map((entry) => {
            const checked = selected.includes(entry.id)
            return (
              <li key={entry.id} className={checked ? `${css.card} ${css.cardSelected}` : css.card} data-skill-card>
                <div className={css.cardHead}>
                  <Checkbox checked={checked} label={entry.name}
                    onChange={() => {
                      setSelected(current => current.includes(entry.id)
                        ? current.filter(item => item !== entry.id)
                        : [...current, entry.id])
                    }} />
                  <span className={css.cardToken}>{t('skills.tokenEstimate', { count: String(entry.tokenEstimate) })}</span>
                </div>
                <p className={css.cardDescription}>{entry.description}</p>
                <div className={css.cardMeta}>
                  <span>{entry.license}</span>
                  <span>{t(isBuiltin(entry) ? 'skills.group.builtin' : 'skills.group.installed')}</span>
                  <Button variant="ghost" size="sm" onClick={() => {
                    void previewSkill(projectId, sessionId, entry.id, t).then(setPreview, (cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    })
                  }}>{t('skills.preview')}</Button>
                </div>
              </li>
            )
          })}
        </ul>
        })()}
      {preview !== null && (
        <Modal
          open
          onClose={() => { setPreview(null) }}
          title={preview.id}
          description={`${preview.license} · ${t('skills.tokenEstimate', { count: String(preview.tokenEstimate) })}`}
          closeLabel={t('skills.close')}
          className={css.previewDialog as string}
          contentClassName={css.previewContent as string}
        >
          <pre className={css.previewBody} data-skill-tab-preview>{preview.content}</pre>
        </Modal>
      )}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
      {notice !== null && <p className={css.notice} role="status">{notice}</p>}
      <div className={css.footer}>
        <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('skills.save')}</Button>
      </div>
    </section>
  )
}
