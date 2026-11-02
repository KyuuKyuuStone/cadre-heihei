/** Skill-admin session/plan transport shared by the library entry and the plan card. */

export interface SkillAdminSession {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  readonly workspaceId?: string
}

export interface SkillAdminMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}

export interface SkillAdminMessages {
  readonly messages: readonly SkillAdminMessage[]
  readonly nextSeq: number
}

export interface SkillPlan {
  readonly planId: string
  readonly kind: 'install' | 'update' | 'remove' | 'unsupported'
  readonly packId: string
  readonly sourceUrl?: string
  readonly author?: string
  readonly license?: string
  readonly contentHash?: string
  readonly targetDir?: string
  readonly actions: readonly string[]
  readonly riskFlags: readonly string[]
  readonly summary: string
  readonly reason?: string
  readonly expiresAt: string
  readonly confirmToken?: string
}

export interface ApplyResult {
  readonly status: 'applied' | 'unsupported' | 'failed'
  readonly packId?: string
  readonly auditId?: string
  readonly error?: string
}

interface Envelope<T> {
  readonly ok?: boolean
  readonly result?: T
  readonly code?: string
  readonly message?: string
}

export class SkillAdminError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SkillAdminError'
  }
}

async function adminCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/cadre/skills/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || payload?.ok !== true || payload.result === undefined) {
    throw new SkillAdminError(payload?.code ?? `HTTP_${response.status}`, payload?.message ?? `技能管理员请求失败（HTTP ${response.status}）`)
  }
  return payload.result
}

/** Create an ordinary admin session and bind it to the supervisor operator. */
export function createSkillAdminSession(projectId: string): Promise<SkillAdminSession> {
  return adminCall('session', { projectId })
}

/** List ordinary sessions whose preset is the hidden skill administrator. */
export function listSkillAdminSessions(projectId: string): Promise<readonly SkillAdminSession[]> {
  return adminCall('sessions', { projectId })
}

/** Delete one ordinary admin session. */
export function deleteSkillAdminSession(projectId: string, operatorSessionId: string, sessionId: string): Promise<{ deleted: true }> {
  return adminCall('delete-session', { projectId, operatorSessionId, sessionId })
}

/** Send one supervisor message to the admin conversation. */
export function sendSkillAdminMessage(
  projectId: string, actorSessionId: string, sessionId: string, text: string,
): Promise<{ accepted: true }> {
  return adminCall('message', { projectId, actorSessionId, sessionId, text })
}

/** Read admin messages after a sequence number. */
export function readSkillAdminMessages(
  projectId: string, actorSessionId: string, sessionId: string, afterSeq: number,
): Promise<SkillAdminMessages> {
  return adminCall('messages', { projectId, actorSessionId, sessionId, afterSeq })
}

/** Apply or cancel one confirmed plan. */
export function applySkillPlan(input: {
  readonly projectId: string
  readonly operatorSessionId: string
  readonly planId: string
  readonly token: string
  readonly action: 'apply' | 'cancel'
}): Promise<ApplyResult> {
  return adminCall('apply', {
    projectId: input.projectId,
    operatorSessionId: input.operatorSessionId,
    planId: input.planId,
    token: input.token,
    ...(input.action === 'cancel' ? { action: 'cancel' } : {}),
  })
}

/** Parse the structured JSON the skill_plan tool records as its text result. */
export function parseSkillPlan(content: readonly { readonly type: string; readonly text?: string }[]): SkillPlan | undefined {
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text) as Partial<SkillPlan>
    if (typeof parsed.planId !== 'string' || typeof parsed.kind !== 'string' || typeof parsed.expiresAt !== 'string') return undefined
    return {
      planId: parsed.planId,
      kind: parsed.kind,
      packId: typeof parsed.packId === 'string' ? parsed.packId : '',
      ...(typeof parsed.sourceUrl === 'string' ? { sourceUrl: parsed.sourceUrl } : {}),
      ...(typeof parsed.author === 'string' ? { author: parsed.author } : {}),
      ...(typeof parsed.license === 'string' ? { license: parsed.license } : {}),
      ...(typeof parsed.contentHash === 'string' ? { contentHash: parsed.contentHash } : {}),
      ...(typeof parsed.targetDir === 'string' ? { targetDir: parsed.targetDir } : {}),
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter((item): item is string => typeof item === 'string') : [],
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags.filter((item): item is string => typeof item === 'string') : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      expiresAt: parsed.expiresAt,
      ...(typeof parsed.confirmToken === 'string' ? { confirmToken: parsed.confirmToken } : {}),
    }
  } catch {
    return undefined
  }
}

/** Map a transport/business failure to a stable user-facing locale key. */
export function skillAdminErrorKey(code: string): string {
  switch (code) {
    case 'SKILL_ADMIN_PLAN_EXPIRED': return 'skills.admin.error.expired'
    case 'SKILL_ADMIN_PLAN_NOT_FOUND': return 'skills.admin.error.used'
    case 'SKILL_ADMIN_TOKEN_INVALID': return 'skills.admin.error.token'
    case 'SKILL_ADMIN_PLAN_INVALID': return 'skills.admin.error.changed'
    case 'SKILL_BUILTIN_READONLY': return 'skills.admin.error.builtin'
    case 'SKILL_ADMIN_FORBIDDEN':
    case 'SKILL_FORBIDDEN': return 'skills.admin.error.forbidden'
    case 'SKILL_ADMIN_DELETE_UNSUPPORTED': return 'skills.admin.error.deleteUnsupported'
    case 'SKILL_ADMIN_UNAVAILABLE': return 'skills.admin.error.unavailable'
    case 'SKILL_ADMIN_SESSION_FAILED': return 'skills.admin.error.session'
    case 'SKILL_ADMIN_PRESET_MISSING': return 'skills.admin.error.preset'
    case 'SKILL_ADMIN_MESSAGE_UNSUPPORTED': return 'skills.admin.error.messageUnsupported'
    default: return 'skills.admin.error.generic'
  }
}
