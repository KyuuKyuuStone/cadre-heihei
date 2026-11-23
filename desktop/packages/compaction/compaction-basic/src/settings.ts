/**
 * Live Settings overrides for the effective compaction policy.
 *
 * The composition row `compaction-settings` exposes only the volatile
 * `auto` and `thresholdRatio` fields, so a Settings write updates the running
 * engine without remounting its fiber. Safety fields (`thresholdTokens`,
 * retention, step thresholds, overflow retries) stay composition-owned and are
 * rejected by the Settings write path because this schema omits them.
 *
 * @module @deepseek-ai/dsh-compaction-basic/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live policy overrides written through the `compaction-settings` Settings namespace. */
    compactionSettings: CompactionSettings
  }
}

/** Volatile Settings fields; an absent value keeps the composition policy. */
export interface Config {
  /** Suppress automatic pressure and overflow-recovery listeners when `false`; manual compaction remains available. */
  auto: Volatile<boolean | undefined>
  /** Default fraction of the usable pressure budget in `(0, 1]`; exact model policies still win and the capacity ceiling still caps it. */
  thresholdRatio: Volatile<number | undefined>
}

/** Detached live overrides read by the engine at decision time. */
export interface CompactionSettingsOverrides {
  /** Automatic compaction switch, or `undefined` when Settings has no stored value. */
  auto?: boolean
  /** Default usable-pressure-budget ratio, or `undefined` when Settings has no stored value. */
  thresholdRatio?: number
}

/**
 * Owns the two live compaction overrides. Each operation reads the volatile
 * references in place, so an accepted Settings write changes the next decision
 * without reloading the plugin.
 */
export class CompactionSettings extends Service {
  static Config = z.object({
    auto: z.boolean().volatile(),
    thresholdRatio: z.number().min(Number.MIN_VALUE).max(1).volatile(),
  })

  /**
   * @param ctx - owning context that provides the `compaction-settings` entry.
   * @param config - volatile references mutated by the Settings write path.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'compactionSettings')
    this.config = config
  }

  private readonly config: Config

  /**
   * Current automatic-compaction switch.
   * @returns the stored override, or `undefined` to keep the composition value.
   */
  get auto(): boolean | undefined {
    return this.config.auto.get()
  }

  /**
   * Current default fraction of the usable pressure budget.
   * @returns the stored override in `(0, 1]`, or `undefined` to keep the composition value.
   */
  get thresholdRatio(): number | undefined {
    return this.config.thresholdRatio.get()
  }

  /**
   * Read both live overrides for one decision.
   * @returns a detached override object; absent fields keep the composition policy.
   */
  current(): CompactionSettingsOverrides {
    return { ...this.auto === undefined ? {} : { auto: this.auto }, ...this.thresholdRatio === undefined ? {} : { thresholdRatio: this.thresholdRatio } }
  }
}

export default CompactionSettings
