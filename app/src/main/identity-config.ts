/**
 * 启动身份来源与台账成员校验（M4 §8.1）。
 *
 * 优先级：env（仅测试/smoke）→ `<userData>/identity.json` → 缺失即 denied。
 * 禁止匿名缺省；env 三项必须同时存在，部分配置视为非法（不静默回落文件）。
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ProjectMembership } from '../collab/dispatch/store-port.ts'
import type { IpcIdentity } from '../shared/ipc.ts'

export interface LoadedIdentity extends IpcIdentity {
  readonly source: 'env' | 'file'
}

export type IdentityLoadResult =
  | { readonly ok: true; readonly identity: LoadedIdentity }
  | {
      readonly ok: false
      readonly reason: 'missing' | 'invalid-env' | 'invalid-file' | 'read-error'
      /** 不含密钥，可写日志。 */
      readonly detail: string
    }

function parseRole(value: unknown): IpcIdentity['role'] | undefined {
  return value === 'supervisor' || value === 'worker' ? value : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function loadIdentityFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): IdentityLoadResult | undefined {
  const projectId = nonEmpty(env.CADRE_PROJECT_ID)
  const sessionId = nonEmpty(env.CADRE_SESSION_ID)
  const roleRaw = nonEmpty(env.CADRE_ROLE)
  if (projectId === undefined && sessionId === undefined && roleRaw === undefined) return undefined
  const role = parseRole(roleRaw)
  if (projectId === undefined || sessionId === undefined || role === undefined) {
    return { ok: false, reason: 'invalid-env', detail: 'CADRE_PROJECT_ID/SESSION_ID/ROLE 必须同时有效' }
  }
  return { ok: true, identity: { projectId, sessionId, role, source: 'env' } as LoadedIdentity }
}

export function loadIdentityFromFile(path: string): IdentityLoadResult | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ok: false, reason: 'invalid-file', detail: 'identity.json 不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid-file', detail: 'identity.json 必须是对象' }
  }
  const record = parsed as Record<string, unknown>
  const projectId = nonEmpty(record.projectId)
  const sessionId = nonEmpty(record.sessionId)
  const role = parseRole(record.role)
  if (projectId === undefined || sessionId === undefined || role === undefined) {
    return {
      ok: false,
      reason: 'invalid-file',
      detail: 'identity.json 需含非空 projectId/sessionId 与 supervisor|worker role',
    }
  }
  return { ok: true, identity: { projectId, sessionId, role, source: 'file' } as LoadedIdentity }
}

export function loadIdentity(
  env: Readonly<Record<string, string | undefined>>,
  identityPath: string,
): IdentityLoadResult {
  const fromEnv = loadIdentityFromEnv(env)
  if (fromEnv !== undefined) return fromEnv
  const fromFile = loadIdentityFromFile(identityPath)
  if (fromFile !== undefined) return fromFile
  return { ok: false, reason: 'missing', detail: `未配置身份（env 或 ${identityPath}）` }
}

export type MemberValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-member' | 'role-mismatch' }

/** 只比对台账 members；不存在与角色不符都不得泄露给 UI。 */
export function validateIdentityAgainstMembers(
  identity: IpcIdentity,
  members: readonly ProjectMembership[],
): MemberValidation {
  const member = members.find(
    (candidate) =>
      String(candidate.projectId) === String(identity.projectId) &&
      String(candidate.sessionId) === String(identity.sessionId),
  )
  if (member === undefined) return { ok: false, reason: 'not-member' }
  if (member.role !== identity.role) return { ok: false, reason: 'role-mismatch' }
  return { ok: true }
}
