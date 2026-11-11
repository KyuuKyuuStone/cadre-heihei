import { describe, expect, it, vi } from 'vitest'
import type { SkillConversationPort, SkillSearchProvider } from '../src/conversation.ts'
import { SkillConversationExecutor } from '../src/conversation.ts'
import { registerSkillConversationTools, skillConversationTools } from '../src/conversation-tools.ts'
import type { ToolRegistration } from '../src/conversation-tools.ts'
import { SkillIpcError } from '../src/ipc.ts'

const DESCRIPTIONS: Record<string, string> = {
  skill_catalog: 'List installed and builtin skills available to the current project.',
  skill_search: 'Search remote skills and fall back to the local catalog when remote search is unavailable.',
  skill_preview: 'Read one local or remote skill manifest and SKILL.md without writing files.',
  skill_install: 'Install one skill by package name, HTTPS URL, or free text after the required confirmation.',
  skill_create: 'Create a local skill from explicit metadata and SKILL.md content.',
  skill_check: 'Check skill package health and return actionable issues without modifying files.',
  skill_audit: 'Read skill operation audits visible to the current actor.',
  skill_plan: 'Create a non-executed install, update, or remove plan for user confirmation.',
}

interface FakePort extends SkillConversationPort {
  readonly calls: string[]
}

function fakePort(overrides: Partial<SkillConversationPort> = {}): FakePort {
  const calls: string[] = []
  const base: SkillConversationPort = {
    resolve: async () => ({ projectId: 'p1', role: 'supervisor' }),
    catalog: async (sessionId, projectId, query) => {
      calls.push(`catalog:${sessionId}:${projectId ?? ''}:${query}`)
      return [{ id: 'pdf', name: 'PDF', description: 'd', origin: 'installed', license: 'MIT', roles: [], tokenEstimate: 4, tools: [], source: 'installed', selected: true }]
    },
    searchable: async (_sessionId, _projectId, query) => {
      calls.push(`searchable:${query}`)
      return [{ packId: 'pdf', name: 'PDF', description: 'd', sourceUrl: 'https://example.test/pdf', license: 'MIT' }]
    },
    preview: async () => ({ id: 'pdf', name: 'PDF', description: 'd', content: '# PDF', tokenEstimate: 4, license: 'MIT' }),
    create: async (_sessionId, _projectId, input) => {
      calls.push(`create:${input.id}`)
      return { id: input.id, name: input.name, description: input.description, origin: 'installed', license: 'unknown', roles: ['supervisor', 'worker'], tokenEstimate: 1, tools: [], source: 'created', selected: true }
    },
    install: async (_sessionId, _projectId, input) => {
      calls.push(`install:${input.name ?? input.url ?? input.text ?? ''}`)
      return { kind: 'package', target: input.name ?? 'x', installed: true, warnings: [] }
    },
    check: async (_sessionId, _projectId, packId) => ({
      status: 'ok', items: [{ packId: packId ?? 'all', status: 'ok', issues: [] }], summary: { total: 1, ok: 1, warning: 0, error: 0 },
    }),
    audit: async () => [],
    plan: async () => ({ planId: 'plan-1', kind: 'install', packId: '', summary: 's', expiresAt: 'e', actions: [], riskFlags: [], confirmToken: 't' }),
    record: () => undefined,
    ...overrides,
  }
  return Object.assign(base, { calls })
}

function find(tools: readonly ToolRegistration[], name: string): ToolRegistration {
  const found = tools.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

describe('conversational skill tools', () => {
  it('exposes the eight tools with the pinned descriptions and argument rules', () => {
    const tools = skillConversationTools(new SkillConversationExecutor({ port: fakePort() }))
    expect(tools.map(tool => tool.name)).toEqual(Object.keys(DESCRIPTIONS))
    for (const tool of tools) expect(tool.description).toBe(DESCRIPTIONS[tool.name])
    const search = find(tools, 'skill_search').parameters as { required: string[]; properties: Record<string, { maximum?: number; minimum?: number }> }
    expect(search.required).toEqual(['query'])
    expect(search.properties.limit!.maximum).toBe(20)
    expect(search.properties.limit!.minimum).toBe(1)
    const create = find(tools, 'skill_create').parameters as { required: string[] }
    expect(create.required).toEqual(['id', 'name', 'description', 'content'])
    const plan = find(tools, 'skill_plan').parameters as { properties: Record<string, { enum?: string[] }> }
    expect(plan.properties.kind!.enum).toEqual(['install', 'update', 'remove'])
    const audit = find(tools, 'skill_audit').parameters as { properties: Record<string, { maximum?: number }> }
    expect(audit.properties.limit!.maximum).toBe(50)
  })

  it('answers catalog and search through the session caller with a local-search fallback', async () => {
    const port = fakePort()
    const tools = skillConversationTools(new SkillConversationExecutor({ port }))
    const catalog = await find(tools, 'skill_catalog').execute({ query: 'pdf' }, { agent: { id: 's1' } }) as { ok: boolean; skills: unknown[] }
    expect(catalog.ok).toBe(true)
    expect(port.calls).toContain('catalog:s1:p1:pdf')
    expect(catalog.skills).toHaveLength(1)
    const search = await find(tools, 'skill_search').execute({ query: 'pdf' }, { agent: { id: 's1' } }) as {
      ok: boolean; source: string; degraded: boolean; message?: string; items: unknown[]
    }
    expect(search.ok).toBe(true)
    expect(search.source).toBe('local')
    expect(search.degraded).toBe(true)
    expect(search.message).toContain('远程搜索不可用')
    expect(search.items).toHaveLength(1)
  })

  it('uses the remote provider when one is configured', async () => {
    const provider: SkillSearchProvider = { search: vi.fn(async () => [{ packId: 'remote', name: 'R', description: 'd', sourceUrl: 'https://example.test/r', license: 'MIT' }]) }
    const tools = skillConversationTools(new SkillConversationExecutor({ port: fakePort(), search: provider }))
    const search = await find(tools, 'skill_search').execute({ query: 'r' }, { agent: { id: 's1' } }) as { source: string; degraded: boolean }
    expect(search.source).toBe('remote')
    expect(search.degraded).toBe(false)
    expect(provider.search).toHaveBeenCalledTimes(1)
  })

  it('turns a resolver rejection into the documented failure envelope', async () => {
    const port = fakePort({ resolve: async () => { throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目') } })
    const tools = skillConversationTools(new SkillConversationExecutor({ port }))
    const result = await find(tools, 'skill_catalog').execute({}, { agent: { id: 's1' } }) as {
      ok: boolean; code: string; message: string; remediation: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('SKILL_PROJECT_REQUIRED')
    expect(result.message).toContain('无法确定项目')
    expect(result.remediation.length).toBeGreaterThan(0)
  })

  it('forwards pack health checks and clamps the audit limit', async () => {
    const port = fakePort()
    const tools = skillConversationTools(new SkillConversationExecutor({ port }))
    const check = await find(tools, 'skill_check').execute({ packId: 'pdf' }, { agent: { id: 's1' } }) as { status: string; items: Array<{ packId: string }> }
    expect(check.status).toBe('ok')
    expect(check.items[0]?.packId).toBe('pdf')
    const audit = await find(tools, 'skill_audit').execute({ limit: 999 }, { agent: { id: 's1' } }) as { ok: boolean; items: unknown[] }
    expect(audit.ok).toBe(true)
    expect(audit.items).toEqual([])
  })

  it('registers every tool even when one name is already taken, and disposes its own rows', () => {
    const disposers: Array<() => void> = []
    const registered: string[] = []
    const ctx = {
      tools: {
        register(tool: ToolRegistration): () => void {
          if (tool.name === 'skill_catalog') throw new Error('duplicate tool name skill_catalog')
          registered.push(tool.name)
          const dispose = (): void => { disposers.push(() => undefined) }
          return dispose
        },
      },
    }
    const dispose = registerSkillConversationTools(ctx, new SkillConversationExecutor({ port: fakePort() }))
    expect(registered).toHaveLength(7)
    expect(registered).not.toContain('skill_catalog')
    dispose()
    expect(disposers).toHaveLength(7)
  })
})
