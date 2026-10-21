/**
 * 每会话 patch 生成（M2 §1.4 / S8 证据）。
 *
 * - identity patch：新增 MCP server 行必须包在 `- insert:` 中；
 * - supervisor patch：只覆盖 base profile 已有行（禁止 insert）；
 * - 每会话一个独立目录，内容带 sessionId；写入采用临时文件 + rename；
 * - 身份/DB/server 缺失或写入失败一律 fail-closed，不产生可启动的匿名 runtime。
 * 本文件不 import harness。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { RuntimeRegistryError } from './errors.ts'

export const DEFAULT_SERVER_NAME = 'cadre'
export const DEFAULT_NODE_COMMAND = 'node'
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

const SUPERVISOR_DISABLED_ROWS = [
  'tool-pwsh',
  'tool-bash',
  'tool-jobs',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-workflow',
  'ptc-runtime',
  'workflow-ptc',
] as const

export type RuntimeRole = 'supervisor' | 'worker'

export interface IdentityPatchInput {
  readonly sessionId: string
  readonly projectId: string
  readonly databasePath: string
  readonly serverPath: string
  readonly serverName?: string
  readonly nodeCommand?: string
  readonly toolCallTimeoutMs?: number
}

export interface SupervisorPatchInput {
  readonly sessionId: string
  readonly projectId: string
}

export interface SessionPatchInput extends IdentityPatchInput {
  readonly runtimeId: string
  readonly role: RuntimeRole
  readonly patchDirBase: string
}

export interface SessionPatchSet {
  readonly patchDir: string
  readonly identityPath: string
  readonly supervisorPath?: string
  readonly patchPaths: readonly string[]
  readonly identityContent: string
  readonly supervisorContent?: string
}

function requireText(value: unknown, field: string, rawCode = 'PATCH_INVALID_IDENTITY'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeRegistryError(
      'ENGINE_PROTOCOL',
      `patch generation requires a non-empty ${field}`,
      false,
      rawCode,
    )
  }
  return value
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function safePatchId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
  return safe === '' ? 'session' : safe
}

/** 生成 MCP 身份 patch；新增行必须用 insert。 */
export function buildIdentityPatch(input: IdentityPatchInput): string {
  const sessionId = requireText(input.sessionId, 'sessionId')
  const projectId = requireText(input.projectId, 'projectId')
  const databasePath = requireText(input.databasePath, 'databasePath', 'PATCH_MISSING_DATABASE')
  const serverPath = requireText(input.serverPath, 'serverPath', 'PATCH_MISSING_SERVER')
  const serverName = input.serverName ?? DEFAULT_SERVER_NAME
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', `invalid MCP serverName: ${serverName}`, false, 'PATCH_INVALID_SERVER_NAME')
  }
  const nodeCommand = input.nodeCommand ?? DEFAULT_NODE_COMMAND
  requireText(nodeCommand, 'nodeCommand', 'PATCH_INVALID_NODE')
  const toolCallTimeoutMs = input.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (!Number.isInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1) {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', 'toolCallTimeoutMs must be a positive integer', false, 'PATCH_INVALID_TIMEOUT')
  }
  const id = `mcp-${safePatchId(sessionId)}`
  const content = [
    `# sessionId: ${sessionId}`,
    `# projectId: ${projectId}`,
    '- insert:',
    `    - id: ${id}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${serverName}`,
    '        transport: stdio',
    `        command: ${quote(nodeCommand)}`,
    '        args:',
    `          - ${quote(serverPath)}`,
    "          - '--project-id'",
    `          - ${quote(projectId)}`,
    "          - '--session-id'",
    `          - ${quote(sessionId)}`,
    "          - '--database-path'",
    `          - ${quote(databasePath)}`,
    '        env:',
    `          CADRE_PROJECT_ID: ${quote(projectId)}`,
    `          CADRE_SESSION_ID: ${quote(sessionId)}`,
    `          CADRE_DB_PATH: ${quote(databasePath)}`,
    '        reconnect:',
    '          enabled: false',
    '        failOnStartupError: true',
    `        toolCallTimeoutMs: ${String(toolCallTimeoutMs)}`,
    '',
  ].join('\n')
  if (!content.includes('- insert:') || !content.includes(sessionId)) {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', 'identity patch validation failed', false, 'PATCH_VALIDATION_FAILED')
  }
  return content
}

/** 主管 patch：只覆盖 base 已有行；不含 insert。 */
export function buildSupervisorPatch(input: SupervisorPatchInput): string {
  const sessionId = requireText(input.sessionId, 'sessionId')
  const projectId = requireText(input.projectId, 'projectId')
  const lines = [
    `# sessionId: ${sessionId}`,
    `# projectId: ${projectId}`,
    '# supervisorGuard L1: keep read/read_image/glob/grep; remove mutation/exec/delegation.',
    '- id: tool-fs',
    '  config:',
    '    write: false',
    '    edit: false',
  ]
  for (const row of SUPERVISOR_DISABLED_ROWS) {
    lines.push(`- id: ${row}`, '  disabled: true')
  }
  lines.push('')
  const content = lines.join('\n')
  if (content.includes('- insert:') || !content.includes(sessionId)) {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', 'supervisor patch validation failed', false, 'PATCH_VALIDATION_FAILED')
  }
  return content
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清理失败不遮蔽原始错误。
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeRegistryError(
      'ENGINE_UNAVAILABLE',
      `failed to write per-session patch: ${message}`,
      false,
      'PATCH_WRITE_FAILED',
    )
  }
}

/** 写入一个会话的 patch 目录；失败时不留下可启动的半成品。 */
export function writeSessionPatches(input: SessionPatchInput): SessionPatchSet {
  if (input.role !== 'supervisor' && input.role !== 'worker') {
    throw new RuntimeRegistryError('ENGINE_PROTOCOL', `invalid runtime role: ${String(input.role)}`, false, 'PATCH_INVALID_ROLE')
  }
  const runtimeId = requireText(input.runtimeId, 'runtimeId', 'PATCH_INVALID_RUNTIME')
  const patchDirBase = requireText(input.patchDirBase, 'patchDirBase', 'PATCH_INVALID_RUNTIME')
  if (!existsSync(input.serverPath)) {
    throw new RuntimeRegistryError(
      'ENGINE_UNAVAILABLE',
      `MCP server path does not exist: ${input.serverPath}`,
      false,
      'PATCH_MISSING_SERVER',
    )
  }

  const identityContent = buildIdentityPatch(input)
  const supervisorContent = input.role === 'supervisor' ? buildSupervisorPatch(input) : undefined
  const patchDir = join(patchDirBase, runtimeId)
  const identityPath = join(patchDir, 'identity.cordis.yml')
  const supervisorPath = supervisorContent === undefined ? undefined : join(patchDir, 'supervisor.cordis.yml')
  try {
    mkdirSync(patchDir, { recursive: true })
    atomicWrite(identityPath, identityContent)
    if (supervisorPath !== undefined && supervisorContent !== undefined) {
      atomicWrite(supervisorPath, supervisorContent)
    }
    for (const path of [identityPath, supervisorPath].filter((item): item is string => item !== undefined)) {
      const written = readFileSync(path, 'utf8')
      if (!written.includes(input.sessionId)) {
        throw new RuntimeRegistryError(
          'ENGINE_UNAVAILABLE',
          `written patch does not contain sessionId: ${path}`,
          false,
          'PATCH_VALIDATION_FAILED',
        )
      }
    }
  } catch (error) {
    rmSync(patchDir, { recursive: true, force: true })
    if (error instanceof RuntimeRegistryError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeRegistryError(
      'ENGINE_UNAVAILABLE',
      `failed to persist per-session patch: ${message}`,
      false,
      'PATCH_WRITE_FAILED',
    )
  }

  return {
    patchDir,
    identityPath,
    ...(supervisorPath === undefined ? {} : { supervisorPath }),
    patchPaths: supervisorPath === undefined ? [identityPath] : [identityPath, supervisorPath],
    identityContent,
    ...(supervisorContent === undefined ? {} : { supervisorContent }),
  }
}

/**
 * 把 active patch 移到 per-runtime archive；幂等：
 * 已归档（active 不存在、archive 存在）时返回 archive 路径，不报错。
 */
export function archiveSessionPatches(
  activePaths: readonly string[],
  archiveDir: string,
): { readonly archivedPaths: readonly string[]; readonly missing: readonly string[] } {
  mkdirSync(archiveDir, { recursive: true })
  const archivedPaths: string[] = []
  const missing: string[] = []
  for (const activePath of activePaths) {
    const archivePath = join(archiveDir, basename(activePath))
    if (resolve(activePath) === resolve(archivePath)) {
      archivedPaths.push(archivePath)
      continue
    }
    if (existsSync(activePath)) {
      rmSync(archivePath, { force: true })
      try {
        renameSync(activePath, archivePath)
      } catch {
        try {
          writeFileSync(archivePath, readFileSync(activePath), { flag: 'wx' })
          rmSync(activePath, { force: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new RuntimeRegistryError(
            'ENGINE_UNAVAILABLE',
            `failed to archive per-session patch: ${message}`,
            false,
            'PATCH_ARCHIVE_FAILED',
          )
        }
      }
      archivedPaths.push(archivePath)
      continue
    }
    if (existsSync(archivePath)) {
      archivedPaths.push(archivePath)
      continue
    }
    missing.push(activePath)
  }
  return { archivedPaths, missing }
}
