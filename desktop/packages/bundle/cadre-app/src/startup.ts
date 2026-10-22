/**
 * Startup entry for the Cadre employee-template bundle.
 *
 * The bundle adds no command-line flags and publishes no startup service: the
 * desktop launcher passes nothing it would read, and every preset row reads
 * its configuration from the patch. The module is still built because the
 * workspace Host build takes `lib/types/{index,startup}.js` as the entry pair
 * for every bundle (`tsdown.config.ts`); omitting it fails that build rather
 * than merely leaving an unused file out.
 * @module @deepseek-ai/dsh-bundle-cadre/startup
 */

/** Stable Cordis plugin name; never composed by the patch. */
export const name = 'cadre-startup'

/** No-op startup body: this bundle declares no flags and no services. */
export function apply(): void {}
