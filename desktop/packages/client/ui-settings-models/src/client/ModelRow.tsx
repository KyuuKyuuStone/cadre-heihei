/** Shared model fields and actions for both adapter catalog editors. */

import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { formatCapacity } from './capacity.ts'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import { ModelReasoningEfforts } from './ModelReasoningEfforts.tsx'
import type { ReservationView } from './reservation.ts'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  /** Levels the row's `reasoningEfforts` may declare; absent or empty shows no reasoning control. */
  reasoningLevels?: readonly string[] | undefined
  expanded: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  /**
   * The row's output-reservation consequence view, computed by the owning
   * editor from values it legitimately owns; absent renders no readout.
   */
  reservation?: ReservationView | undefined
  /**
   * Apply the view's suggested default to the row's `maxTokens`. The remedy is
   * an explicit click, never an automatic rewrite of a stored value; absent
   * hides the action (a warning without a readable default still informs).
   */
  onReservationAdopt?: (() => void) | undefined
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
}

/** The meta template for one view: inherited marker and window share are independent. */
function reservationMetaKey(view: ReservationView): ModelsKey {
  if (view.inherited) {
    return view.percent === '' ? 'reservationMetaInherited' : 'reservationMetaInheritedShare'
  }
  return view.percent === '' ? 'reservationMeta' : 'reservationMetaShare'
}

/**
 * Render consistent model identity, capacity, and input-type controls.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one expandable model entry.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled, reservation } = props
  return (
    <div className={styles['modelEntry']}>
      <div className={styles['modelRow']}>
        {(['id', 'name'] as const).map(field => (
          <input
            key={field}
            className={styles['input']}
            type="text"
            value={typeof model[field] === 'string' ? model[field] : ''}
            placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
            aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value
              props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
            }}
            onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
          />
        ))}
        <button
          type="button"
          className={styles['iconButton']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          title={t('modelAdvanced')}
          onClick={props.onToggle}
        >
          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
        </button>
        <button
          type="button"
          className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      </div>
      {props.expanded
        ? (
          <div className={styles['modelAdvanced']}>
            {(['contextWindow', 'maxTokens'] as const).map(field => (
              <label className={styles['modelField']} key={field}>
                <span className={styles['modelFieldLabel']}>{t(field)}</span>
                <input
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={props[field].value}
                  placeholder={props[field].placeholder}
                  aria-label={`${t(field)} ${String(position)}`}
                  disabled={disabled}
                  onChange={(event) => { props[field].onChange(event.target.value) }}
                  onBlur={props[field].onBlur}
                />
              </label>
            ))}
            {reservation !== undefined
              ? (
                <p className={styles['modelReservation']}>
                  {t(reservationMetaKey(reservation))
                    .replace('{value}', formatCapacity(reservation.reserved))
                    .replace('{percent}', reservation.percent)}
                </p>
              )
              : null}
            {reservation?.warning !== undefined
              ? (
                <div className={styles['reservationNotice']}>
                  <p className={styles['notice']}>
                    {reservation.suggested !== undefined
                      ? t('reservationWarningDefault')
                        .replace('{value}', formatCapacity(reservation.reserved))
                        .replace('{default}', formatCapacity(reservation.suggested))
                      : t('reservationWarningShare').replace('{percent}', reservation.percent)}
                  </p>
                  {reservation.suggested !== undefined && props.onReservationAdopt !== undefined
                    ? (
                      <button
                        type="button"
                        className={styles['linkButton']}
                        disabled={disabled}
                        onClick={props.onReservationAdopt}
                      >
                        {t('reservationAdopt').replace('{value}', formatCapacity(reservation.suggested))}
                      </button>
                    )
                    : null}
                </div>
              )
              : null}
            <ModelInputTypes
              model={model} field={props.inputField} position={position}
              fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange}
            />
            {props.reasoningLevels !== undefined && props.reasoningLevels.length > 0
              ? (
                <ModelReasoningEfforts
                  model={model} levels={props.reasoningLevels} position={position} disabled={disabled} t={t} onChange={props.onChange}
                />
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}
