/** Staged edits over the two volatile fields of `compaction-settings`. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Host namespace edited by this page. */
export const COMPACTION_SETTINGS_NS = 'compaction-settings'

/** The only Host fields this page may write. */
export interface CompactionSettings {
  /** Automatic pressure and overflow handling; absent inherits composition. */
  auto?: boolean
  /** Usable-pressure-budget ratio; absent inherits composition. */
  thresholdRatio?: number
}

/** Form snapshot rendered by the compaction page. */
export interface CompactionCardState extends SettingsFormShell {
  /** Tri-state automatic-compaction field: empty means no user override. */
  auto: SettingsFieldState
  /** Editable ratio field; empty means no user override. */
  thresholdRatio: SettingsFieldState
}

/** Reactive state and narrow actions injected into the page. */
export interface CompactionCardFace extends SettingsFormActions {
  /** Renderer-bound snapshot source. */
  hooks: { compactionCard: SnapshotStore<CompactionCardState> }
}

/** Owns one staged form without exposing its Settings scope to the component. */
export class CompactionCardController {
  private readonly form: SettingsFormModel<CompactionSettings>
  private readonly store: SnapshotStore<CompactionCardState>

  /** @param scope - live Host form for `compaction-settings`. */
  constructor(scope: SettingsFormScope<CompactionSettings>) {
    this.form = new SettingsFormModel(scope, [
      {
        field: 'auto',
        format: value => typeof value === 'boolean' ? String(value) : '',
        parse: text => {
          if (text === '') return { kind: 'clear' }
          if (text === 'true') return { kind: 'set', value: true }
          if (text === 'false') return { kind: 'set', value: false }
          return undefined
        },
      },
      {
        ...settingsNumberField('thresholdRatio'),
        parse: text => {
          if (text.trim() === '') return { kind: 'clear' }
          const value = Number(text)
          return Number.isFinite(value) && value > 0 && value <= 1 ? { kind: 'set', value } : undefined
        },
      },
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /** @returns the current form shell and both field projections. */
  private projection(): CompactionCardState {
    return { ...this.form.shell(), auto: this.form.field('auto'), thresholdRatio: this.form.field('thresholdRatio') }
  }

  /**
   * Create the component-facing form facade without exposing the Settings scope.
   * @returns plain actions and the renderer-bound form snapshot.
   */
  inject(): CompactionCardFace {
    return { ...this.form.actions(), hooks: { compactionCard: this.store } }
  }

  /** Release the Settings scope subscription with the plugin fiber. */
  dispose(): void { this.form.dispose() }
}
