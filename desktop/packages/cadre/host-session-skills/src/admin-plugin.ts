/** Skill tools for the hidden `cadre-skill-admin` preset. @module */
import type { SkillAdminApi } from './admin.ts'
import { SkillConversationExecutor } from './conversation.ts'
import { registerSkillConversationTools } from './conversation-tools.ts'
import type { ToolRegistration } from './conversation-tools.ts'

/** The `tools` and `skillAdmin` services this preset-scoped row requires. */
interface AdminContext {
  readonly tools: { register(tool: ToolRegistration): () => void }
  get(name: 'skillAdmin'): SkillAdminApi | undefined
  on?(event: 'dispose', listener: () => void): unknown
}

/** Stable Cordis plugin name kept for the old preset row. */
export const name = 'skill-admin-tools'

/** Services required by the preset-scoped row. */
export const inject = ['tools', 'skillAdmin']

/**
 * Register the eight conversational skill tools on the admin preset.
 *
 * The row reuses the shared registrar so a session never stacks two sets of the same
 * tools. Execution keeps this preset's 1.5.7 semantics: the project binding is recovered
 * on first use and the admin session acts as the roster supervisor's operator.
 * @param ctx - preset-scoped context with tools and the shared admin service.
 */
export function apply(ctx: AdminContext): void {
  const service = (): SkillAdminApi => {
    const admin = ctx.get('skillAdmin')
    if (admin === undefined) throw new Error('技能管理员服务未挂载')
    return admin
  }
  const executor = new SkillConversationExecutor({ port: service().conversationPort() })
  const dispose = registerSkillConversationTools(ctx, executor)
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', dispose)
  }
}
