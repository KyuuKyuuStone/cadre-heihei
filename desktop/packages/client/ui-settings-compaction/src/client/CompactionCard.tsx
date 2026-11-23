/** The Plugins-page form for live context-compaction overrides. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SegmentedControl, SettingsForm, SettingsValueField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompactionCardFace } from './compaction-card-controller.ts'
import { formLabels } from './locales.ts'
import styles from './CompactionCard.module.css'

/** Props the renderer binds for the compaction page. */
export type CompactionCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.compaction'>
  & InjectFace<CompactionCardFace>

/**
 * Render the one-line summary or the staged compaction settings form.
 * @param props - view, locale copy, reactive form state, and narrow actions.
 * @returns the summary or settings form.
 */
export function CompactionCard(props: CompactionCardProps) {
  const { t } = props
  const state = props.useCompactionCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable || state.saving
  const auto = state.auto.text === 'true' || state.auto.text === 'false' ? state.auto.text : 'inherit'
  const autoHint = auto === 'inherit' ? 'autoInheritedHint' : auto === 'true' ? 'autoEnabledHint' : 'autoDisabledHint'
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={styles.field}>
        <div className={styles.head}>
          <span className={styles.label}>{t('auto')}</span>
          {state.auto.overridden
            ? (
              <span className={styles.badges}>
                <Tag tone="neutral">{t('overridden')}</Tag>
                <button type="button" className={styles.reset} disabled={disabled} onClick={() => { props.resetField('auto') }}>
                  {t('reset')}
                </button>
              </span>
            )
            : null}
        </div>
        <SegmentedControl
          id="plugin-config-compaction-auto"
          className={styles.control}
          label={t('auto')}
          value={auto}
          disabled={disabled}
          options={[
            { value: 'inherit', label: t('autoInherited') },
            { value: 'true', label: t('autoEnabled') },
            { value: 'false', label: t('autoDisabled') },
          ]}
          onChange={(next) => {
            if (next === 'inherit') props.resetField('auto')
            else props.edit('auto', next)
          }}
        />
        <p
          id={`plugin-config-compaction-auto-${auto}-panel`}
          role="tabpanel"
          aria-labelledby={`plugin-config-compaction-auto-${auto}`}
          className={styles.hint}
        >
          {t(autoHint)}
        </p>
      </div>
      <SettingsValueField
        id="plugin-config-compaction-threshold-ratio"
        label={t('thresholdRatio')}
        hint={t('thresholdRatioHint')}
        placeholder={t('thresholdRatioPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidRatio')}
        numeric
        disabled={disabled}
        {...state.thresholdRatio}
        onEdit={(text) => { props.edit('thresholdRatio', text) }}
        onReset={() => { props.resetField('thresholdRatio') }}
      />
      <section className={styles.notes} aria-label={t('behaviorTitle')}>
        <h2>{t('behaviorTitle')}</h2>
        <p>{t('pressureBudget')}</p>
        <p>{t('overflowFallback')}</p>
        <p>{t('manualCompaction')}</p>
      </section>
      <section className={styles.safety} aria-label={t('safetyTitle')}>
        <h2>{t('safetyTitle')}</h2>
        <p>{t('safetyDescription')}</p>
        <dl>
          <div><dt><code>{t('safetyAbsoluteFields')}</code></dt><dd>{t('safetyAbsolute')}</dd></div>
          <div><dt><code>{t('safetyRetentionFields')}</code></dt><dd>{t('safetyRetention')}</dd></div>
          <div><dt><code>{t('safetyStepFields')}</code></dt><dd>{t('safetyStep')}</dd></div>
          <div><dt><code>{t('safetyOverflowFields')}</code></dt><dd>{t('safetyOverflow')}</dd></div>
        </dl>
      </section>
    </SettingsForm>
  )
}
