/**
 * Model-facing tools for the skills-page administrator. The row is mounted only
 * inside the `cadre-skill-admin` preset, so no other session sees these tools.
 * @module @deepseek-ai/dsh-host-session-skills/admin
 */
import type { SkillAdminApi, SkillPlan } from './admin.ts'

/** Tool start/end payload the registry passes to `execute`. */
interface ToolRun {
  readonly agent?: { readonly id: string }
}

interface ToolContent {
  readonly type: 'text'
  readonly text: string
}

interface ToolRegistration {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly render: (args: unknown, value: never) => readonly ToolContent[]
  }
  execute(args: Readonly<Record<string, unknown>>, run: ToolRun): Promise<unknown>
}

interface AdminContext {
  readonly tools: { register(tool: ToolRegistration): unknown }
  get(name: 'skillAdmin'): SkillAdminApi | undefined
}

/** Stable Cordis plugin name. */
export const name = 'skill-admin-tools'

/** Services required by the preset-scoped row. */
export const inject = ['tools', 'skillAdmin']

const CORE_PLAN_FIELDS = ['planId', 'kind', 'packId', 'summary', 'expiresAt'] as const

function text(value: string): readonly ToolContent[] {
  return [{ type: 'text', text: value }]
}

function sessionOf(run: ToolRun): string {
  const id = run.agent?.id
  if (id === undefined) throw new Error('技能管理工具必须由会话内的 Agent 调用')
  return id
}

/**
 * Register the four model tools; the preset decides who can call them.
 * @param ctx - preset-scoped context with tools and the shared admin service.
 */
export function apply(ctx: AdminContext): void {
  const admin = (): SkillAdminApi => {
    const service = ctx.get('skillAdmin')
    if (service === undefined) throw new Error('技能管理员服务未挂载')
    return service
  }

  ctx.tools.register({
    name: 'skill_catalog',
    description: 'List or search installed/builtin skills. Use before previewing or planning a change.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', description: 'Optional case-insensitive filter.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['skills'],
        properties: {
          skills: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'name', 'origin', 'license'],
              properties: {
                id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
                origin: { type: 'string' }, author: { type: 'string' }, homepage: { type: 'string' },
                license: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, run) {
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
      const skills = admin().catalogFor(sessionOf(run)).filter(skill =>
        query === '' || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(query))
      return { skills }
    },
  })

  ctx.tools.register({
    name: 'skill_preview',
    description: 'Read one skill manifest metadata and SKILL.md body. Read-only; never writes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['packId'],
      properties: { packId: { type: 'string', description: 'Catalog skill id.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['id', 'content'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
          author: { type: 'string' }, homepage: { type: 'string' }, license: { type: 'string' },
          content: { type: 'string' }, tokenEstimate: { type: 'number' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, run) {
      const packId = typeof args.packId === 'string' ? args.packId : ''
      if (packId === '') throw new Error('packId 必填')
      return admin().previewFor(sessionOf(run), packId)
    },
  })

  ctx.tools.register({
    name: 'skill_install',
    description: 'Install one skill by package name, URL, or free text. Reuses install-package/install-url/install-any, validates strictly, returns non-blocking warnings for missing provenance, and writes the audit. No plan/apply confirmation is required.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'npm/SkillHub package name, e.g. @scope/name.' },
        url: { type: 'string', description: 'HTTPS GitHub raw/tree or skill URL.' },
        text: { type: 'string', description: 'Free-form instruction containing one package name or URL.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['kind', 'target', 'installed', 'warnings', 'result'],
        properties: {
          kind: { type: 'string' }, target: { type: 'string' }, installed: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          result: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, run) {
      return admin().installForSession(sessionOf(run), {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.text === undefined ? {} : { text: args.text }),
      })
    },
  })

  ctx.tools.register({
    name: 'skill_plan',
    description: 'Create a non-executed install/update/remove plan with source, license, hashes, target, actions, risks and expiry. The user must confirm in the UI before admin/apply runs.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['install', 'update', 'remove'] },
        url: { type: 'string', description: 'HTTPS GitHub raw/tree URL for install/update.' },
        packId: { type: 'string', description: 'Catalog id for update/remove.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: [...CORE_PLAN_FIELDS],
        properties: {
          planId: { type: 'string' }, kind: { type: 'string' }, packId: { type: 'string' },
          sourceUrl: { type: 'string' }, author: { type: 'string' }, license: { type: 'string' },
          contentHash: { type: 'string' }, targetDir: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
          riskFlags: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' }, reason: { type: 'string' },
          expiresAt: { type: 'string' }, confirmToken: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, run) {
      const sessionId = sessionOf(run)
      const kind = args.kind === 'remove' || args.kind === 'update' || args.kind === 'install' ? args.kind : 'install'
      const plan: SkillPlan = await admin().planForSession(sessionId, {
        kind,
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.packId === undefined ? {} : { packId: args.packId }),
      })
      const confirmToken = admin().tokenForSession(sessionId, plan.planId)
      return { ...plan, ...(confirmToken === undefined ? {} : { confirmToken }) }
    },
  })

  ctx.tools.register({
    name: 'skill_audit',
    description: 'Read recent skill install/remove/update audit rows. Read-only; no page bodies or secrets.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'number', description: '1-50, default 20.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, run) {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
      return { items: admin().auditForSession(sessionOf(run), limit) }
    },
  })
}
