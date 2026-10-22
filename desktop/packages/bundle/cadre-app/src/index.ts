/**
 * Cadre employee-template bundle.
 *
 * The bundle's whole contribution is its patch (`cordis.patch.yml`): four
 * `@deepseek-ai/dsh-agent-preset` declarations that the preset registry mounts
 * per Session. Nothing in the patch mounts this module, so it provides no
 * service, registers nothing, and holds no state.
 *
 * It exists because the workspace Host build compiles every
 * `packages/<group>/<name>` bundle from `lib/types/{index,startup}.js`
 * (`tsdown.config.ts` entry); a package without those outputs fails the build
 * with `Cannot find entry`. Keeping the entry a no-op preserves that contract
 * without inventing a runtime surface the bundle does not need.
 * @module @deepseek-ai/dsh-bundle-cadre
 */

/** Stable Cordis plugin name; never composed by the patch. */
export const name = 'cadre-bundle'

/** No-op plugin body: the patch, not this row, carries the presets. */
export function apply(): void {}
