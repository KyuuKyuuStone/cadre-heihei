/** The eight conversational skill tools and their shared registrar. @module */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSkillApi } from './ipc.ts'
import { createAuditLog, createLedgerResolver, createSessionPort, SkillConversationExecutor } from './conversation.ts'
import type { SkillConversationPort, SkillSearchProvider } from './conversation.ts'

/** The executor entry points the tool surface calls; the concrete class satisfies this. */
export type SkillToolExecutor = Pick<SkillConversationExecutor,
'catalog' | 'searchQuery' | 'preview' | 'install' | 'create' | 'check' | 'audit' | 'plan'>

/** One text block returned to the model. */
export interface ToolContent {
  readonly type: 'text'
  readonly text: string
}

/** A tool definition accepted by the `tools` service. */
export interface ToolRegistration {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly render: (args: unknown, value: never) => readonly ToolContent[]
  }
  execute(args: Readonly<Record<string, unknown>>, run: ToolRun): Promise<unknown>
}

/** The `tools` service surface this registrar needs. */
export interface ToolRun {
  readonly agent?: { readonly id: string }
}

/** Context surface the registrar requires. */
export interface ToolsContext {
  readonly tools: { register(tool: ToolRegistration): () => void }
}

const text = (value: string): readonly ToolContent[] => [{ type: 'text', text: JSON.stringify(value) }]

const PROJECT_ID = {
  type: 'string',
  description: 'Project id to operate on; defaults to the caller roster project.',
} as const

const OUTPUT = {
  type: 'object', additionalProperties: true, required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string', description: 'Stable failure code.' },
    message: { type: 'string', description: 'What failed, in user terms.' },
    remediation: { type: 'string', description: 'The corrective action.' },
  },
} as const

function tool(input: {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly run: (args: Readonly<Record<string, unknown>>, run: ToolRun) => Promise<unknown>
}): ToolRegistration {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: { schema: OUTPUT, render: (_args, value) => text(value as string) },
    async execute(args, run) {
      return input.run(args, run)
    },
  }
}

function callerOf(run: ToolRun): string {
  const id = run.agent?.id
  if (id === undefined) throw new Error('技能工具必须由会话内的 Agent 调用')
  return id
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.trunc(value)
}

/**
 * The eight definitions, descriptions fixed verbatim by the design contract.
 * @param executor - the shared executor behind every tool.
 * @returns the tool definitions in stable order.
 */
export function skillConversationTools(executor: SkillToolExecutor): readonly ToolRegistration[] {
  return [
    tool({
      name: 'skill_catalog',
      description: 'List installed and builtin skills available to the current project.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive filter.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => executor.catalog(callerOf(run), optionalString(args.query), optionalString(args.projectId)),
    }),
    tool({
      name: 'skill_search',
      description: 'Search remote skills and fall back to the local catalog when remote search is unavailable.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
          query: { type: 'string', description: 'Free-text query, for example "PDF".' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Result cap; default 5.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => executor.searchQuery(
        callerOf(run), String(args.query ?? ''), optionalInteger(args.limit, 5), optionalString(args.projectId),
      ),
    }),
    tool({
      name: 'skill_preview',
      description: 'Read one local or remote skill manifest and SKILL.md without writing files.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['packId'],
        properties: {
          packId: { type: 'string', description: 'Catalog skill id.' },
          sourceUrl: { type: 'string', description: 'Remote skill URL returned by skill_search.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => executor.preview(
        callerOf(run), String(args.packId ?? ''), optionalString(args.sourceUrl), optionalString(args.projectId),
      ),
    }),
    tool({
      name: 'skill_install',
      description: 'Install one skill by package name, HTTPS URL, or free text after the required confirmation.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'npm/SkillHub package name.' },
          url: { type: 'string', description: 'Credential-free HTTPS skill URL.' },
          text: { type: 'string', description: 'Free-text install instruction.' },
          confirm: { type: 'boolean', description: 'Confirm a warning-bearing install; default false.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => {
        const name = optionalString(args.name)
        const url = optionalString(args.url)
        const text = optionalString(args.text)
        const confirm = optionalBoolean(args.confirm)
        return executor.install(callerOf(run), {
          ...(name === undefined ? {} : { name }),
          ...(url === undefined ? {} : { url }),
          ...(text === undefined ? {} : { text }),
          ...(confirm === undefined ? {} : { confirm }),
        }, optionalString(args.projectId))
      },
    }),
    tool({
      name: 'skill_create',
      description: 'Create a local skill from explicit metadata and SKILL.md content.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'description', 'content'],
        properties: {
          id: { type: 'string', description: '1-64 character kebab-case id.' },
          name: { type: 'string', description: 'Display name.' },
          description: { type: 'string', description: 'One-line summary.' },
          content: { type: 'string', description: 'SKILL.md body.' },
          roles: { type: 'array', items: { type: 'string', enum: ['supervisor', 'worker'] }, description: 'Roles enabled by default.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the skill documents.' },
          tokenEstimate: { type: 'integer', minimum: 0, description: 'Token cost; derived when omitted.' },
          author: { type: 'string', description: 'Upstream author.' },
          homepage: { type: 'string', description: 'Credential-free https homepage.' },
          license: { type: 'string', description: 'SPDX license; default unknown.' },
          overwrite: { type: 'boolean', description: 'Replace an existing id; requires confirm:true.' },
          confirm: { type: 'boolean', description: 'Confirm the overwrite.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => {
        const author = optionalString(args.author)
        const homepage = optionalString(args.homepage)
        const license = optionalString(args.license)
        const overwrite = optionalBoolean(args.overwrite)
        const confirm = optionalBoolean(args.confirm)
        return executor.create(callerOf(run), {
          id: String(args.id ?? ''),
          name: String(args.name ?? ''),
          description: String(args.description ?? ''),
          content: String(args.content ?? ''),
          ...(Array.isArray(args.roles) ? { roles: args.roles.filter((role): role is string => typeof role === 'string') } : {}),
          ...(Array.isArray(args.tools) ? { tools: args.tools.filter((name): name is string => typeof name === 'string') } : {}),
          ...(typeof args.tokenEstimate === 'number' ? { tokenEstimate: args.tokenEstimate } : {}),
          ...(author === undefined ? {} : { author }),
          ...(homepage === undefined ? {} : { homepage }),
          ...(license === undefined ? {} : { license }),
          ...(overwrite === undefined ? {} : { overwrite }),
          ...(confirm === undefined ? {} : { confirm }),
        }, optionalString(args.projectId))
      },
    }),
    tool({
      name: 'skill_check',
      description: 'Check skill package health and return actionable issues without modifying files.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          packId: { type: 'string', description: 'Check one pack; omit to check all.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => executor.check(callerOf(run), optionalString(args.packId), optionalString(args.projectId)),
    }),
    tool({
      name: 'skill_audit',
      description: 'Read skill operation audits visible to the current actor.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Rows to return; default 20.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => executor.audit(callerOf(run), optionalInteger(args.limit, 20), optionalString(args.projectId)),
    }),
    tool({
      name: 'skill_plan',
      description: 'Create a non-executed install, update, or remove plan for user confirmation.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['install', 'update', 'remove'], description: 'Plan kind; default install.' },
          url: { type: 'string', description: 'Credential-free HTTPS skill URL for kind:install.' },
          packId: { type: 'string', description: 'Existing pack id for kind:update or kind:remove.' },
          projectId: PROJECT_ID,
        },
      },
      run: (args, run) => {
        const url = optionalString(args.url)
        const packId = optionalString(args.packId)
        return executor.plan(callerOf(run), {
          kind: args.kind === 'update' || args.kind === 'remove' ? args.kind : 'install',
          ...(url === undefined ? {} : { url }),
          ...(packId === undefined ? {} : { packId }),
        }, optionalString(args.projectId))
      },
    }),
  ]
}

/**
 * Register the eight tools once per tools layer.
 *
 * A same-layer duplicate name is refused by the `tools` service itself; the registrar
 * keeps the other seven rather than failing the whole surface, and its disposer removes
 * exactly the registrations it created. That keeps the preset row and the host row from
 * stacking into a duplicate set while leaving preset-scope shadowing intact.
 * @param ctx - context exposing the `tools` service.
 * @param executor - the shared executor behind the eight tools.
 * @returns the disposer that removes this registration.
 */
export function registerSkillConversationTools(ctx: ToolsContext, executor: SkillToolExecutor): () => void {
  const disposers: (() => void)[] = []
  for (const definition of skillConversationTools(executor)) {
    try {
      disposers.push(ctx.tools.register(definition))
    } catch (error) {
      if (error instanceof Error && /duplicate|already registered/i.test(error.message)) continue
      throw error
    }
  }
  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}

/** Deployment-varying configuration for the conversational skill row. */
export interface Config {
  readonly ledgerPath?: string
  readonly skillsDir?: string
  readonly builtinDir?: string
  readonly auditDir?: string
  readonly searchTimeoutMs?: number
  readonly search?: SkillSearchProvider
}

/** Stable Cordis plugin name for the ordinary and employee sessions. */
export const name = 'skill-conversation-tools'

/** Services required by the host-level row. */
export const inject = ['tools']

/** Context surface the host-level row reads. */
export interface ConversationContext extends ToolsContext {
  get?(name: string): unknown
  on?(event: 'dispose', listener: () => void): unknown
}

function resolveDirs(config: Config): { ledgerPath: string; skillsDir: string; builtinDir: string; auditDir: string } | undefined {
  const ledgerPath = config.ledgerPath ?? process.env.CADRE_LEDGER_PATH?.trim()
  if (ledgerPath === undefined || ledgerPath === '') {
    console.error('skill-conversation-tools: CADRE_LEDGER_PATH is unset; no skill tools registered')
    return undefined
  }
  const skillsDir = config.skillsDir ?? process.env.CADRE_SKILLS_DIR?.trim() ?? join(homedir(), '.dsh', 'cadre-skills')
  if (skillsDir === '') {
    console.error('skill-conversation-tools: CADRE_SKILLS_DIR is empty; no skill tools registered')
    return undefined
  }
  return {
    ledgerPath,
    skillsDir,
    builtinDir: config.builtinDir ?? process.env.CADRE_BUILTIN_SKILLS_DIR?.trim()
      ?? fileURLToPath(new URL('../builtin-skills/', import.meta.url)),
    auditDir: config.auditDir ?? join(homedir(), '.dsh', 'cadre-skill-admin'),
  }
}

/**
 * Mount the eight conversational skill tools for every preset and session.
 * @param ctx - host context with the `tools` service.
 * @param config - optional directory and search overrides.
 */
export function apply(ctx: ConversationContext, config: Config = {}): void {
  const dirs = resolveDirs(config)
  if (dirs === undefined) return
  const db = new DatabaseSync(dirs.ledgerPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  const api = createSkillApi({
    db,
    ledgerPath: dirs.ledgerPath,
    skillsDir: dirs.skillsDir,
    builtinDir: dirs.builtinDir,
    auditDir: dirs.auditDir,
  })
  const port: SkillConversationPort = createSessionPort({
    api,
    resolver: createLedgerResolver(db),
    skillsDir: dirs.skillsDir,
    builtinDir: dirs.builtinDir,
    audit: createAuditLog(join(dirs.auditDir, 'audit.jsonl')),
  })
  const injected = typeof ctx.get === 'function' ? ctx.get('skillSearchProvider') : undefined
  const search = config.search ?? (isSearchProvider(injected) ? injected : undefined)
  const executor = new SkillConversationExecutor({
    port,
    ...(search === undefined ? {} : { search }),
    ...(config.searchTimeoutMs === undefined ? {} : { searchTimeoutMs: config.searchTimeoutMs }),
  })
  const dispose = registerSkillConversationTools(ctx, executor)
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      dispose()
      db.close()
    })
  }
}

function isSearchProvider(value: unknown): value is SkillSearchProvider {
  return typeof value === 'object' && value !== null && typeof (value as { search?: unknown }).search === 'function'
}
