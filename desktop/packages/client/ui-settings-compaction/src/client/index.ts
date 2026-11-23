/** Browser registration for the live context-compaction settings page. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CompactionCard } from './CompactionCard.tsx'
import { COMPACTION_SETTINGS_NS, CompactionCardController } from './compaction-card-controller.ts'
import { en, zh, type CompactionSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Context compaction settings page copy. */
    'settings.compaction': CompactionSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.compaction'

/** Required services (Cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the page only while the Host serves `compaction-settings`.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-compaction: dictionaries')
  const card = new CompactionCardController(ctx.configForms.get(COMPACTION_SETTINGS_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-compaction: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([COMPACTION_SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'compaction-settings', order: 35, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, CompactionCard))), 'ui-settings-compaction: page')
}
