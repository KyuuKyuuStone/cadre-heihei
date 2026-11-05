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

const pluginIds = (text: string): string[] =>
  [...text.matchAll(/^\s+- id: (\S+)$/gmu)].map(match => match[1] as string)

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
  it('publishes cadre beside the four upstream presets without replacing them', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string[] } }
    }
    const patches = pkg.dsh?.bundle?.patch ?? []
    expect(patches).toEqual(expect.arrayContaining([
      './presets/standard.patch.yml', './presets/ptc.patch.yml',
      './presets/minimal.patch.yml', './presets/cordis.patch.yml', './presets/cadre.patch.yml',
    ]))
    for (const [name, id] of [['standard', 'standard'], ['ptc', 'ptc'], ['minimal', 'minimal'], ['cordis', 'cordis'], ['cadre', 'cadre']] as const) {
      const text = preset(name)
      expect(text).toMatch(new RegExp(`id: ${id}\\b`, 'u'))
      expect(text).toMatch(new RegExp(`source: ${id === 'cadre' ? 'cadre' : 'deepseek'}`, 'u'))
    }
  })

  it('keeps the Cadre composition focused on team tools and removes unrelated web access', () => {
    const standard = pluginIds(preset('standard')).filter(id => !id.startsWith('preset-'))
    const cadre = pluginIds(preset('cadre')).filter(id => !id.startsWith('preset-'))
    for (const required of [
      'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
      'tool-jobs', 'tool-skill', 'tool-todo', 'present',
    ]) {
      expect(cadre).toContain(required)
    }
    expect(cadre).not.toContain('tool-web')
    expect(standard).toContain('tool-web')
    expect(preset('cadre')).toContain('name: Cadre 团队模式')
    expect(preset('cadre')).toContain('source: cadre')
    expect(preset('cadre')).toContain('Dispatch template')
  })

  it('ships the cadre-team builtin skill with the preset guidance', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../../cadre/host-session-skills/builtin-skills/cadre-team/manifest.json', import.meta.url),
      'utf8',
    )) as { id: string; descriptionI18n?: { zh?: string } }
    const skill = readFileSync(
      new URL('../../../cadre/host-session-skills/builtin-skills/cadre-team/SKILL.md', import.meta.url),
      'utf8',
    )
    expect(manifest.id).toBe('cadre-team')
    expect(manifest.descriptionI18n?.zh).toBeTruthy()
    expect(skill).toContain('Dispatch template')
    expect(skill).toContain('Release preflight')
  })

  it('mounts the skill-admin tools only in the skill-admin preset', () => {
    const cadreApp = readFileSync(new URL('../../cadre-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(cadreApp).toContain('id: cadre-skill-admin')
    expect(cadreApp).toContain("name: '@deepseek-ai/dsh-host-session-skills/admin'")
    expect(cadreApp).toContain('sampleOverCapGlobResults: false')
    expect(preset('cadre')).not.toContain('host-session-skills/admin')
  })

  it('satisfies the required tool-fs-search config that broke the admin preset', () => {
    expect(FileSearchConfig({ sampleOverCapGlobResults: false })).toMatchObject({
      sampleOverCapGlobResults: false,
    })
  })

  it('wires the Cadre compaction budget onto the row the standard preset actually mounts', () => {
    const config = presetCompactionConfig()
    expect(config).toEqual({
      thresholdTokens: 120_000,
      retainTokens: 10_000,
      stepPressureCheck: true,
      stepPressureThresholdTokens: 120_000,
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
    expect(spec.thresholdTokens).toBe(120_000)
    expect(spec.retainTokens).toBe(10_000)
    expect(resolved.stepPressureThresholdTokens).toBe(120_000)
    expect(resolved.auto).toBe(true)
  })

  it('keeps the Cadre bundle free of the dead host-plane compaction override', () => {
    const cadre = readFileSync(new URL('../../cadre-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(cadre).not.toMatch(/^\s*-\s*id:\s*compaction-basic\b/mu)
    // The host-plane spill row is still live, so its Cadre cap stays here.
    expect(cadre).toMatch(/maxInlineTokens:\s*2000/u)
  })
})
