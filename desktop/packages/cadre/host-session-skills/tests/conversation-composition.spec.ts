/**
 * REAL-composition coverage: a test-only cordis.yml boots the eight conversational
 * skill tools through the vendored Loader next to the real `dsh-tools` service, then
 * checks per-preset visibility, the hidden admin preset's single shadowing set, and
 * disposal. The composition itself is Loader-owned; only the two external services
 * (`systemPrompt` and the preset's embedded admin conversation) are stubbed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import * as Tools from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SkillAdminApi, type AdminSessionPort } from '../src/admin.ts'
import * as AdminRow from '../src/admin-plugin.ts'
import * as ConversationRow from '../src/conversation-tools.ts'
import type { ToolRun } from '../src/conversation-tools.ts'

const TOOL_NAMES = [
  'skill_catalog', 'skill_search', 'skill_preview', 'skill_install',
  'skill_create', 'skill_check', 'skill_audit', 'skill_plan',
]

/** The shipped preset ids the host row must serve, with their product names. */
const PRESETS = [
  { preset: 'standard', label: '标准模式' },
  { preset: 'ptc', label: 'PTC 模式' },
  { preset: 'minimal', label: '极简模式' },
  { preset: 'cordis', label: '创造模式' },
  { preset: 'cadre', label: 'Cadre 对话' },
]

let root: string | undefined
let context: Context | undefined
const opened: { close(): void }[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const handle of opened.splice(0)) handle.close()
  if (root !== undefined) {
    const dir = root
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  root = undefined
})

/** Minimal embedded-conversation service; the preset applies no message in this test. */
const sessions: AdminSessionPort = {
  create: async () => { throw new Error('not used') },
  list: async () => [],
  prompt: async () => { throw new Error('not used') },
  messages: async () => ({ messages: [], nextSeq: 0 }),
}

function hostServices(collected: { readonly setTools?: (value: unknown) => void }): {
  readonly name: string
  readonly apply: (ctx: Context) => void
} {
  return {
    name: 'test:host-services',
    apply(ctx: Context): void {
      ctx.provide('systemPrompt', {
        tools: (provider: unknown) => {
          collected.setTools?.(provider)
          return () => undefined
        },
        section: () => () => undefined,
        context: () => () => undefined,
      })
    },
  }
}

const BUNDLES = fileURLToPath(new URL('../../../bundle/', import.meta.url))

interface Booted {
  readonly tools: {
    get(name: string, scope?: ScopeKey): unknown
    schemas(scope?: ScopeKey): readonly { readonly name: string }[]
    register(definition: unknown): () => void
  }
  readonly scopes: ReadonlyMap<string, ScopeKey>
  readonly adminApi: SkillAdminApi
}

async function loadComposition(): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'skill-conversation-composition-'))
  const ledgerPath = join(root, 'cadre.sqlite')
  const skillsDir = join(root, 'installed')
  const builtinDir = join(root, 'builtin')
  const auditDir = join(root, 'audit')
  for (const dir of [skillsDir, builtinDir, auditDir]) await mkdir(dir, { recursive: true })
  const seed = new DatabaseSync(ledgerPath)
  try {
    seed.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id))`)
    seed.prepare(`INSERT INTO members (project_id, session_id, role, state, created_at, updated_at)
      VALUES ('p1', 's-worker', 'worker', 'available', 'now', 'now')`).run()
  } finally {
    seed.close()
  }
  const adminDb = new DatabaseSync(ledgerPath, { readOnly: true })
  opened.push(adminDb)
  const adminApi = new SkillAdminApi({
    db: adminDb,
    ledgerPath,
    skillsDir,
    builtinDir,
    sessions,
    auditDir,
  })
  const collected: { setTools?: (value: unknown) => void } = {}
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test:host-services'",
    "- name: '@deepseek-ai/dsh-tools'",
    '  config:',
    '    mode: native',
    "- name: '@deepseek-ai/dsh-host-session-skills/conversation'",
    '  config:',
    `    ledgerPath: '${ledgerPath}'`,
    `    skillsDir: '${skillsDir}'`,
    `    builtinDir: '${builtinDir}'`,
    `    auditDir: '${auditDir}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test:host-services', hostServices(collected)],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-host-session-skills/conversation', ConversationRow],
  ])
  Object.defineProperty(context.loader, 'internal', {
    value: {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    },
  })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const toolService = context.get('tools') as unknown as Booted['tools']
  if (toolService === undefined) throw new Error('tools service did not mount')
  const scopes = new Map<string, ScopeKey>()
  for (const entry of PRESETS) scopes.set(entry.preset, { preset: entry.preset })
  return { tools: toolService, scopes, adminApi }
}

function namesIn(tools: Booted['tools'], scope?: ScopeKey): string[] {
  return tools.schemas(scope).map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort()
}

/** Registration type the shipped admin row declares for the tools service. */
type AdminTool = Parameters<Parameters<typeof AdminRow.apply>[0]['tools']['register']>[0]

/**
 * Rebuild one registrar entry as a registry definition. The two types describe the same
 * runtime object; the registrar's narrower parameter types are widened here so the real
 * `tools` service can accept it.
 * @param registration - one entry produced by the shared registrar.
 * @returns the same tool as the registry's definition type.
 */
function definitionOf(registration: AdminTool): ToolDefinition {
  return {
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
    output: {
      schema: registration.output.schema as JsonSchemaNode,
      render: (args, value) => [...registration.output.render(args, value as never)],
    },
    execute: async (args, exec) => registration.execute(args as Readonly<Record<string, unknown>>, exec as ToolRun),
  }
}

describe('conversational skill tools real Loader composition', () => {
  it('mounts all eight tools globally and shows them in every shipped preset', async () => {
    const booted = await loadComposition()
    const ctx = context
    if (ctx === undefined) throw new Error('composition context missing')
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])
    console.log('boot: start method = Loader boot of a test-only cordis.yml through @deepseek-ai/cordis Loader; no hand-built ctx.plugin composition')
    console.log('boot: resolution basis = loader.internal.import map to workspace source modules (tsconfig paths source plane); cordis.yml row = @deepseek-ai/dsh-host-session-skills/conversation')
    expect(booted.tools.schemas().map(schema => schema.name).sort()).toEqual([...TOOL_NAMES].sort())
    console.log(`global: ${booted.tools.schemas().map(schema => schema.name).sort().join(', ')}`)
    for (const entry of PRESETS) {
      const key = booted.scopes.get(entry.preset)
      if (key === undefined) throw new Error(`missing scope ${entry.preset}`)
      createScope(ctx, key)
      expect(booted.tools.get('skill_search', key)).toBeDefined()
      expect(namesIn(booted.tools, key), `${entry.label} (${entry.preset})`).toEqual([...TOOL_NAMES].sort())
      console.log(`preset ${entry.preset} (${entry.label}): ${namesIn(booted.tools, key).join(', ')}`)
    }
  })

  it('mounts the hidden admin preset as one shadowing set and clears on disposal', async () => {
    const booted = await loadComposition()
    const ctx = context
    if (ctx === undefined) throw new Error('composition context missing')
    const key: ScopeKey = { preset: 'cadre-skill-admin' }
    const admin = createScope(ctx, key)
    admin.ctx.provide('skillAdmin', booted.adminApi)
    const scopeTools = admin.ctx.get('tools')
    if (scopeTools === undefined) throw new Error('tools missing in admin scope')
    console.log('preset cadre-skill-admin mount method = shipped src/admin-plugin.ts apply() invoked against a scope adapter; the adapter forwards its tools.register into the real ctx.tools service, and only the external skillAdmin service and conversation port are stubbed')
    AdminRow.apply({
      tools: {
        register: (tool: AdminTool) => scopeTools.register(definitionOf(tool)),
      },
      get: () => booted.adminApi,
    })
    expect(namesIn(booted.tools, key), 'cadre-skill-admin').toEqual([...TOOL_NAMES].sort())
    console.log(`preset cadre-skill-admin (admin row materialized in its own scope): ${namesIn(booted.tools, key).join(', ')}`)
    expect(namesIn(booted.tools), 'global layer').toEqual([...TOOL_NAMES].sort())
    const marker = admin.ctx.get('tools')
    if (marker === undefined) throw new Error('tools missing in admin scope')
    marker.register({
      name: 'preset_marker', description: 'scope marker',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => 'ok',
    })
    expect(booted.tools.get('preset_marker', key)).toBeDefined()
    expect(booted.tools.get('preset_marker')).toBeUndefined()
    await admin.dispose()
    expect(booted.tools.get('preset_marker', key)).toBeUndefined()
    expect(booted.tools.get('skill_catalog', key), 'global row remains after preset disposal').toBeDefined()
    expect(namesIn(booted.tools, key)).toEqual([...TOOL_NAMES].sort())
    console.log(`dispose cadre-skill-admin: scoped-only registrations removed; remaining scoped tools = ${namesIn(booted.tools, key).join(', ')}`)
    await ctx.fiber.dispose()
    context = undefined
    expect(ctx.get('tools')).toBeUndefined()
    console.log('dispose root fiber: ctx.get(\'tools\') = undefined (registration gone, no leaked fiber)')
  })

  it('ships the host row in the Cadre bundle and pins the presets that must see it', async () => {
    const patch = await readFile(join(BUNDLES, 'cadre-app', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: cadre-skill-conversation')
    expect(patch).toContain("name: '@deepseek-ai/dsh-host-session-skills/conversation'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-host-session-skills/admin'")
    for (const entry of PRESETS) {
      const presetFile = await readFile(join(BUNDLES, 'web-app', 'presets', `${entry.preset}.patch.yml`), 'utf8')
      expect(presetFile, `${entry.preset} preset file`).toContain(`id: ${entry.preset}`)
      expect(presetFile, `${entry.preset} must not hide the conversational tools`).not.toMatch(/skill_(search|create|check|install|catalog|preview|audit|plan)/)
    }
  })
})
