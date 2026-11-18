/**
 * Model-visible tool surface: the eight names and English descriptions are pinned
 * verbatim to DESIGN §2, with the documented limits, required fields, and enums.
 */
import { describe, expect, it } from 'vitest'
import { skillConversationTools, type SkillToolExecutor } from '../src/conversation-tools.ts'

/** DESIGN §2 rows: tool name to the exact English description the model sees. */
const SURFACE: Readonly<Record<string, string>> = {
  skill_catalog: 'List installed and builtin skills available to the current project.',
  skill_search: 'Search remote skills and fall back to the local catalog when remote search is unavailable.',
  skill_preview: 'Read one local or remote skill manifest and SKILL.md without writing files.',
  skill_install: 'Install one skill by package name, HTTPS URL, or free text after the required confirmation.',
  skill_create: 'Create a local skill from explicit metadata and SKILL.md content.',
  skill_check: 'Check skill package health and return actionable issues without modifying files.',
  skill_audit: 'Read skill operation audits visible to the current actor.',
  skill_plan: 'Create a non-executed install, update, or remove plan for user confirmation.',
}

const unused = async (): Promise<never> => { throw new Error('unused') }
const executor: SkillToolExecutor = {
  catalog: unused,
  searchQuery: unused,
  preview: unused,
  install: unused,
  create: unused,
  check: unused,
  audit: unused,
  plan: unused,
}

const tools = skillConversationTools(executor)

function parametersOf(name: string): Readonly<Record<string, unknown>> {
  const entry = tools.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`missing tool ${name}`)
  return entry.parameters
}

function propertiesOf(name: string): Readonly<Record<string, unknown>> {
  const properties = parametersOf(name).properties
  if (typeof properties !== 'object' || properties === null) return {}
  return properties as Readonly<Record<string, unknown>>
}

describe('DESIGN §2 model-visible tool surface', () => {
  it('exports exactly the eight named tools in a stable order', () => {
    expect(tools.map(entry => entry.name)).toEqual(Object.keys(SURFACE))
    expect(tools).toHaveLength(8)
  })

  it('pins each English description verbatim', () => {
    for (const entry of tools) {
      expect(entry.description).toBe(SURFACE[entry.name as keyof typeof SURFACE])
      console.log(`surface\t${entry.name}\t${entry.description}`)
    }
  })

  it('keeps the documented parameter limits, required fields, and enums', () => {
    expect(parametersOf('skill_search').required).toEqual(['query'])
    expect(propertiesOf('skill_search').limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 20 })
    expect(propertiesOf('skill_audit').limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 })
    const install = propertiesOf('skill_install')
    for (const field of ['name', 'url', 'text']) expect(install[field]).toMatchObject({ type: 'string' })
    expect(install.confirm).toMatchObject({ type: 'boolean' })
    expect(parametersOf('skill_create').required).toEqual(expect.arrayContaining(['id', 'name', 'description', 'content']))
    const create = propertiesOf('skill_create')
    expect(create.roles).toMatchObject({ type: 'array' })
    expect(create.overwrite).toMatchObject({ type: 'boolean' })
    expect(create.confirm).toMatchObject({ type: 'boolean' })
    expect(propertiesOf('skill_plan').kind).toMatchObject({ type: 'string', enum: ['install', 'update', 'remove'] })
    expect(parametersOf('skill_preview').required).toEqual(['packId'])
    expect(propertiesOf('skill_preview').sourceUrl).toMatchObject({ type: 'string' })
  })
})
