/** Chat toolview for one skill_plan result: preview, confirm, cancel, and error states. */
import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  parseSkillPlan,
  SkillAdminError,
  skillAdminErrorKey,
  type ApplyResult,
} from './CadreSkillAdmin.ts'
import css from './CadreSkillPlanCard.module.css'

export interface CadreSkillPlanInjected {
  applyPlan: (planId: string, token: string, action: 'apply' | 'cancel') => Promise<ApplyResult>
}

/** Locally mirrored tool-call contract: the tool slot lives in ui-tool, which cannot be a static dependency here. */
interface PlanCardProps extends InjectFace<CadreSkillPlanInjected> {
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block: { readonly content: readonly { readonly type: string; readonly text?: string }[] }
  readonly t: PropsLocale<'sidebar'>['t']
}

/** Render one skill_plan tool call and its user-confirmation actions. */
export function CadreSkillPlanCard({ phase, block, applyPlan, t }: PlanCardProps) {
  const [pending, setPending] = useState<'apply' | 'cancel' | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (phase !== 'result') {
    return <div className={css.pending}>{t('skills.admin.plan.preparing')}</div>
  }
  const plan = parseSkillPlan(block.content)
  if (plan === undefined) {
    return <div className={css.pending}>{t('skills.admin.plan.unreadable')}</div>
  }
  const expired = Date.parse(plan.expiresAt) <= Date.now()
  const unsupported = plan.kind === 'unsupported'
  const canApply = !unsupported && !expired && plan.confirmToken !== undefined && result?.status !== 'applied'
  const run = async (action: 'apply' | 'cancel'): Promise<void> => {
    if (plan.confirmToken === undefined) {
      setError(t('skills.admin.error.token'))
      return
    }
    setPending(action)
    setError(null)
    try {
      setResult(await applyPlan(plan.planId, plan.confirmToken, action))
    } catch (cause) {
      setError(cause instanceof SkillAdminError
        ? t(skillAdminErrorKey(cause.code) as never)
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }
  return (
    <section className={css.card} data-skill-plan data-plan-kind={plan.kind}>
      <header className={css.head}>
        <span className={css.title}>{t('skills.admin.plan.title')}</span>
        <Tag tone={unsupported || expired ? 'outline' : 'solid'}>
          {t(unsupported ? 'skills.admin.plan.unsupported' : expired ? 'skills.admin.plan.expired' : 'skills.admin.plan.ready')}
        </Tag>
        <code className={css.planId}>{plan.planId.slice(0, 8)}</code>
      </header>
      <p className={css.summary}>{plan.summary}</p>
      <dl className={css.meta}>
        {plan.sourceUrl !== undefined && <><dt>{t('skills.admin.plan.source')}</dt><dd>{plan.sourceUrl}</dd></>}
        {plan.author !== undefined && <><dt>{t('skills.admin.plan.author')}</dt><dd>{plan.author}</dd></>}
        {plan.license !== undefined && <><dt>{t('skills.admin.plan.license')}</dt><dd>{plan.license}</dd></>}
        {plan.contentHash !== undefined && <><dt>{t('skills.admin.plan.hash')}</dt><dd><code>{plan.contentHash}</code></dd></>}
        {plan.targetDir !== undefined && <><dt>{t('skills.admin.plan.target')}</dt><dd><code>{plan.targetDir}</code></dd></>}
        <dt>{t('skills.admin.plan.actions')}</dt><dd>{plan.actions.join(', ')}</dd>
        <dt>{t('skills.admin.plan.risks')}</dt><dd>{plan.riskFlags.join(', ') || t('skills.admin.plan.risksNone')}</dd>
        <dt>{t('skills.admin.plan.expires')}</dt><dd>{plan.expiresAt}</dd>
      </dl>
      {plan.reason !== undefined && <p className={css.reason} role="status">{plan.reason}</p>}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
      {result !== null && (
        <p className={result.status === 'failed' ? css.error : css.notice} role="status">
          {result.status === 'applied'
            ? t('skills.admin.result.applied', { packId: result.packId ?? plan.packId })
            : result.status === 'unsupported'
              ? t('skills.admin.result.cancelled')
              : t('skills.admin.result.failed', { error: result.error ?? '' })}
        </p>
      )}
      {!unsupported && result?.status !== 'applied' && (
        <footer className={css.footer}>
          <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => { void run('cancel') }}>
            {t('skills.admin.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!canApply || pending !== null} onClick={() => { void run('apply') }}>
            {pending === 'apply' ? t('skills.admin.applying') : t('skills.admin.confirm')}
          </Button>
        </footer>
      )}
      {unsupported && <p className={css.reason}>{t('skills.admin.plan.unsupportedHint')}</p>}
    </section>
  )
}
