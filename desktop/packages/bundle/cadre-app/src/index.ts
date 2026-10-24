/**
 * Cadre employee-template bundle.
 *
 * The bundle contributes only composition: its patch declares the four
 * `cadre-*` presets and mounts the collaboration tools from
 * `@deepseek-ai/dsh-host-collab` (declared as a dependency so the profile-scope
 * linker projects it into the profile).
 * @module @deepseek-ai/dsh-bundle-cadre
 */

/** Stable Cordis plugin name; never composed by the patch. */
export const name = 'cadre-bundle'

/** No-op body: the patch, not this module, carries every row. */
export function apply(): void {}
