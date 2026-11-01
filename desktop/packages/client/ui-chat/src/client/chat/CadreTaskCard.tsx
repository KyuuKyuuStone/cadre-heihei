/**
 * Supervisor task dispatch card. The Host sends a plain user message beginning
 * with `【主管任务】`; only that prefix is folded, so ordinary user messages keep
 * their existing bubble.
 */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CadreTaskCard.module.css'

export interface ParsedCadreTask {
  readonly taskId: string
  readonly title: string
  readonly due: string | undefined
  readonly requirements: string
}

const HEADERS = ['【主管任务】', '【Cadre 任务】'] as const

/**
 * Parse the supervisor dispatch format.
 * @param content - one user message's plain text.
 * @returns card fields, or undefined when this is not a dispatch message.
 */
export function parseCadreTask(content: string): ParsedCadreTask | undefined {
  const header = HEADERS.find(value => content.startsWith(value))
  if (header === undefined) return undefined
  const taskId = /^任务号：(.+)$/m.exec(content)?.[1]?.trim()
  const title = /^标题：(.+)$/m.exec(content)?.[1]?.trim()
  if (taskId === undefined || taskId === '' || title === undefined || title === '') return undefined
  const due = /^截止：(.+)$/m.exec(content)?.[1]?.trim()
  const marker = content.indexOf('交付要求：')
  const requirements = marker === -1
    ? content.slice(header.length).trim()
    : content.slice(marker + '交付要求：'.length).trim()
  return { taskId, title, due: due === '' ? undefined : due, requirements }
}

/** Folded dispatch card; default collapsed, independent of the author role. */
export function CadreTaskNodeView({
  content, t,
}: {
  readonly content: string
  readonly t: PropsLocale<'chat'>['t']
}) {
  const [expanded, setExpanded] = useState(false)
  const task = parseCadreTask(content)
  if (task === undefined) return null
  return (
    <section className={css.card} data-cadre-task-card data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className={css.head}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.title}>{t('taskCard.title')}</span>
        <span className={css.taskTitle}>{task.title}</span>
        <span className={css.meta}>{t('taskCard.taskId', { id: task.taskId })}</span>
        {task.due !== undefined && <span className={css.meta}>{t('taskCard.due', { due: task.due })}</span>}
        <span className={css.toggle}>{t(expanded ? 'taskCard.hide' : 'taskCard.show')}</span>
      </button>
      {expanded && (
        <div className={css.body}>
          <div className={css.bodyHeading}>{t('taskCard.requirements')}</div>
          <div className={css.requirements}>{task.requirements}</div>
        </div>
      )}
    </section>
  )
}
