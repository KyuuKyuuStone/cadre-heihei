// Verifies the Cadre employee templates are ordinary preset declarations the
// registry can list, read, and select. Design: docs/product/design/05-employee-presets.md.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { entryListProblem } from '../../../preset/agent-preset-registry/src/definition.ts'

const PATCH = new URL('../cordis.patch.yml', import.meta.url)
const MANIFEST = new URL('../package.json', import.meta.url)

/** Definitions the patch inserts, in declaration order. */
function definitions(): PresetDefinition[] {
  const document = load(readFileSync(PATCH, 'utf8'), { schema: entryListSchema }) as {
    insert?: { name?: string; config?: PresetDefinition }[]
  }[]
  return document.flatMap(row => row.insert ?? [])
    .filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
    .map(row => row.config as PresetDefinition)
}

/** Every plugin row id under a definition, groups flattened. */
function rowIds(plugins: readonly unknown[]): string[] {
  return plugins.flatMap((entry) => {
    const row = entry as { id?: string; name?: string; group?: boolean; config?: unknown }
    const self = row.id === undefined ? [] : [row.id]
    return row.group === true ? [...self, ...rowIds(row.config as readonly unknown[])] : self
  })
}

it('ships as a bundle patch the manifest declares', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { dsh: { bundle: { patch: string } }; files: string[] }
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.files).toContain('cordis.patch.yml')
})

it('declares the four templates with the designed metadata and no model', () => {
  const declared = definitions()
  expect(declared.map(definition => definition.id)).toEqual(['cadre-dev', 'cadre-novel', 'cadre-general', 'cadre-roleplay'])
  expect(declared.map(definition => definition.name)).toEqual([
    '开发 · Development', '写小说 · Fiction Writing', '通用 · General Assistant', '角色扮演 · Role-play',
  ])
  expect(declared.map(definition => definition.order)).toEqual([110, 111, 112, 113])
  for (const definition of declared) {
    expect(definition.description).toBeTruthy()
    expect(entryListProblem(definition.plugins)).toBeUndefined()
    const persona = definition.plugins.find(row => row.name === '@deepseek-ai/dsh-persona') as
      { config?: Record<string, unknown> } | undefined
    expect(persona?.config?.prefix).toBeTruthy()
    expect(persona?.config?.complete).toBeUndefined()
    expect(persona?.config?.suffix).toBeUndefined()
    // Model routing stays in the session plane.
    expect(JSON.stringify(definition)).not.toMatch(/"models?"\s*:/)
  }
})

it('gives each template its designed tool subset', () => {
  const byId = new Map(definitions().map(definition => [definition.id, rowIds(definition.plugins)]))
  expect(byId.get('cadre-dev')).toEqual(expect.arrayContaining([
    'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-web',
    'tool-ask-user', 'tool-todo', 'skill-filesystem', 'tool-skill', 'planning', 'plan-mode',
    'compaction', 'compaction-basic', 'command-compact', 'tool-result-pruner',
    'delegation', 'tool-subagent', 'tool-workflow',
  ]))
  expect(byId.get('cadre-novel')).toEqual(expect.arrayContaining([
    'tool-fs', 'tool-fs-search', 'tool-web', 'tool-ask-user', 'tool-todo', 'compaction',
  ]))
  expect(byId.get('cadre-novel')).not.toEqual(expect.arrayContaining(['tool-bash', 'tool-pwsh', 'delegation']))
  expect(byId.get('cadre-general')).toEqual(expect.arrayContaining([
    'tool-fs', 'tool-fs-search', 'tool-web', 'tool-ask-user', 'tool-todo', 'compaction',
  ]))
  expect(byId.get('cadre-general')).not.toEqual(expect.arrayContaining(['tool-bash', 'tool-pwsh', 'delegation']))
  expect(byId.get('cadre-roleplay')).toEqual(expect.arrayContaining(['tool-ask-user', 'tool-fs', 'compaction']))
  expect(byId.get('cadre-roleplay')).not.toEqual(expect.arrayContaining([
    'tool-bash', 'tool-pwsh', 'tool-web', 'tool-todo', 'delegation',
  ]))
})

// Roster listing, read, and blank-Session selection run against the booted
// shipped composition in apps/web/tests/cadre-presets.e2e.ts: the registry
// harness has no host plane (fs/jobs/web/subagents), so every preset with tool
// rows is legitimately "waiting for" services there.
