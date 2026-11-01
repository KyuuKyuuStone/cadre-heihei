import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const preset = (name: string): string =>
  readFileSync(new URL(`../presets/${name}.patch.yml`, import.meta.url), 'utf8')

const pluginIds = (text: string): string[] =>
  [...text.matchAll(/^\s+- id: (\S+)$/gmu)].map(match => match[1] as string)

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
})
