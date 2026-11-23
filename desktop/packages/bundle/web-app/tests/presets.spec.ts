import { readFileSync } from 'node:fs'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { Config as FileSearchConfig } from '@deepseek-ai/dsh-tool-fs-search'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** The loader's `!!js` scalar dialect; preset rows may carry platform expressions. */
const entryListSchema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
}))

const preset = (name: string): string =>
  readFileSync(new URL(`../presets/${name}.patch.yml`, import.meta.url), 'utf8')

interface PresetRow {
  readonly id?: string
  readonly config?: unknown
}

/** The config object on the compaction-basic row the preset actually mounts. */
function presetCompactionConfig(): Record<string, unknown> {
  const doc = load(preset('standard'), { schema: entryListSchema }) as Array<{ insert?: PresetRow[] }>
  const standard = (doc[0]?.insert ?? []).find(row => row.id === 'preset-standard')
  const plugins = ((standard?.config as { plugins?: PresetRow[] } | undefined)?.plugins ?? [])
  const group = plugins.find(row => row.id === 'compaction')
  const basic = ((group?.config ?? []) as PresetRow[]).find(row => row.id === 'compaction-basic')
  return (basic?.config ?? {}) as Record<string, unknown>
}

describe('shipped agent presets', () => {
  it('publishes the four upstream presets without replacing them', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string[] } }
    }
    const patches = pkg.dsh?.bundle?.patch ?? []
    expect(patches).toEqual(expect.arrayContaining([
      './presets/standard.patch.yml', './presets/ptc.patch.yml',
      './presets/minimal.patch.yml', './presets/cordis.patch.yml',
    ]))
    for (const id of ['standard', 'ptc', 'minimal', 'cordis'] as const) {
      const text = preset(id)
      expect(text).toMatch(new RegExp(`id: ${id}\\b`, 'u'))
      expect(text).toMatch(/source: deepseek/u)
    }
  })

  it('no longer ships the redundant cadre-team/cadre-workflow builtin skills', () => {
    // Their guidance is hardcoded in SUPERVISOR_DUTY / WORKER_POLICY; shipping
    // them as opt-in packs only duplicated the prompt budget.
    for (const id of ['cadre-team', 'cadre-workflow']) {
      expect(() => readFileSync(
        new URL(`../../../cadre/host-session-skills/builtin-skills/${id}/manifest.json`, import.meta.url),
        'utf8',
      )).toThrow()
    }
  })

  it('mounts the skill-admin tools only in the skill-admin preset', () => {
    const cadreApp = readFileSync(new URL('../../cadre-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(cadreApp).toContain('id: cadre-skill-admin')
    expect(cadreApp).toContain("name: '@deepseek-ai/dsh-host-session-skills/admin'")
    expect(cadreApp).toContain('sampleOverCapGlobResults: false')
    for (const name of ['standard', 'ptc', 'minimal', 'cordis']) {
      expect(preset(name)).not.toContain('host-session-skills/admin')
    }
  })

  it('satisfies the required tool-fs-search config that broke the admin preset', () => {
    expect(FileSearchConfig({ sampleOverCapGlobResults: false })).toMatchObject({
      sampleOverCapGlobResults: false,
    })
  })

  it('wires the Cadre compaction budget onto the row the standard preset actually mounts', () => {
    const config = presetCompactionConfig()
    expect(config).toEqual({
      thresholdTokens: 727_040,
      retainTokens: 10_000,
      stepPressureCheck: true,
      stepPressureThresholdTokens: 727_040,
      stepMinToolCallsBetweenChecks: 0,
    })
    // The row's config must yield the Cadre budgets through the real policy
    // resolution for the routed model, not only as YAML text.
    const resolved = resolveConfig(config as never)
    const spec = resolveCompactSpec(
      resolveTargetPolicy(resolved, { provider: 'deepseek-official', model: 'deepseek-flash' }),
      1_000_000,
      256_000,
    )
    // The cap sits above the routed pressure budget, so the 0.9 ratio wins:
    // floor((1,000,000 − 256,000 − 65,536) × 0.9) = 610,617.
    expect(spec.thresholdTokens).toBe(610_617)
    expect(spec.retainTokens).toBe(10_000)
    expect(resolved.stepPressureThresholdTokens).toBe(727_040)
    expect(resolved.auto).toBe(true)
  })

  it('keeps the Cadre bundle free of the dead host-plane compaction override', () => {
    const cadre = readFileSync(new URL('../../cadre-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(cadre).not.toMatch(/^\s*-\s*id:\s*compaction-basic\b/mu)
    // The host-plane spill row is still live, so its Cadre cap stays here.
    expect(cadre).toMatch(/maxInlineTokens:\s*2000/u)
  })
})
