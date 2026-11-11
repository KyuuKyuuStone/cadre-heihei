/**
 * Read-only diagnostics for the skills-page administrator. This module never
 * writes skill files; the route decides whether a failure should append the
 * session-error log.
 * @module
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillPack } from './catalog.ts'

/** One preset row as the registry exposes it. */
interface PresetRow {
  readonly id: string
  readonly name?: string
  readonly hidden?: boolean
  readonly broken?: string
}

/** Preset registry surface needed by diagnostics. */
export interface PresetDiagnosticsPort {
  list(): Promise<readonly PresetRow[]>
  resolve(id: string): Promise<PresetRow>
}

/** One actionable skill-pack problem. */
export interface Issue {
  readonly code: string
  readonly message: string
  readonly remediation: string
  readonly field?: string
}

/** Health of one skill pack. */
export interface PackCheck {
  readonly packId: string
  readonly status: 'ok' | 'warning' | 'error'
  readonly issues: readonly Issue[]
}

/** Health of the whole catalog, as `skill_check` returns it. */
export interface PackHealth {
  readonly status: 'ok' | 'warning' | 'error'
  readonly items: readonly PackCheck[]
  readonly summary: {
    readonly total: number
    readonly ok: number
    readonly warning: number
    readonly error: number
  }
}

/** Inputs collected from the Host before rendering diagnostics. */
export interface DiagnosticsInput {
  readonly presetId: string
  readonly presets: PresetDiagnosticsPort | undefined
  readonly sessionController: unknown
  readonly adminService: unknown
  /** Optional pack snapshot; when present diagnostics summarize its health. */
  readonly packs?: ReadonlyMap<string, SkillPack>
  /** Whether an injected remote search provider is configured. */
  readonly remoteSearchAvailable?: boolean
}

/** Stable diagnostic payload returned by `/admin/diag`. */
export interface AdminDiagnostics {
  readonly presetId: string
  readonly preset: {
    readonly exists: boolean
    readonly available: boolean
    readonly broken?: string
    readonly row?: PresetRow
  }
  readonly presets: readonly PresetRow[]
  readonly sessionController: { readonly available: boolean }
  readonly admin: {
    readonly serviceAvailable: boolean
    readonly toolsPluginExpected: boolean
  }
  /** Skill-pack health summary; omitted when no pack snapshot was supplied. */
  readonly packs?: {
    readonly total: number
    readonly ok: number
    readonly warning: number
    readonly error: number
  }
  /** Whether the conversational tools can reach a remote skill search. */
  readonly remoteSearch: { readonly available: boolean }
}

/**
 * Collect diagnostics without executing a session or touching skill files.
 * @param input - registry, controller and admin service snapshots.
 * @returns a JSON-safe diagnostic payload.
 */
export async function collectAdminDiagnostics(input: DiagnosticsInput): Promise<AdminDiagnostics> {
  let rows: readonly PresetRow[] = []
  let preset: PresetRow | undefined
  let resolveError: string | undefined
  if (input.presets !== undefined) {
    try {
      rows = await input.presets.list()
    } catch (error) {
      resolveError = error instanceof Error ? error.message : String(error)
    }
    if (rows.some(row => row.id === input.presetId)) {
      try {
        preset = await input.presets.resolve(input.presetId)
      } catch (error) {
        resolveError = error instanceof Error ? error.message : String(error)
      }
    }
  }
  const broken = preset?.broken ?? resolveError
  const health = input.packs === undefined ? undefined : collectPackHealth(input.packs)
  return {
    presetId: input.presetId,
    preset: {
      exists: preset !== undefined || rows.some(row => row.id === input.presetId),
      available: preset !== undefined && broken === undefined,
      ...(broken === undefined ? {} : { broken }),
      ...(preset === undefined ? {} : { row: preset }),
    },
    presets: rows,
    sessionController: { available: input.sessionController !== undefined },
    admin: {
      serviceAvailable: input.adminService !== undefined,
      toolsPluginExpected: true,
    },
    ...(health === undefined ? {} : { packs: health.summary }),
    remoteSearch: { available: input.remoteSearchAvailable === true },
  }
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const LICENSES_MISSING = new Set(['', 'unknown'])

function metadataIssue(pack: SkillPack): Issue[] {
  const issues: Issue[] = []
  if (!KEBAB_ID.test(pack.id) || pack.id.length > 64) {
    issues.push({
      code: 'PACK_METADATA_INVALID',
      message: `技能包 id ${pack.id} 不是 1-64 位 kebab-case`,
      remediation: '把目录名与 manifest.json 的 id 改成 1-64 位 kebab-case 后重新检查',
      field: 'id',
    })
  }
  if (pack.name.trim() === '') {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包缺少名称', remediation: '在 manifest.json 填写非空 name 后重新检查', field: 'name' })
  }
  if (pack.description.trim() === '') {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包缺少描述', remediation: '在 manifest.json 填写非空 description 后重新检查', field: 'description' })
  }
  if (LICENSES_MISSING.has(pack.license.trim())) {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包未声明许可证', remediation: '在 manifest.json 填写 license（如 MIT）后重新检查', field: 'license' })
  }
  if (pack.roles.length === 0) {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包没有可用角色', remediation: '在 manifest.json 的 roles 中补 supervisor 或 worker 后重新检查', field: 'roles' })
  }
  if (!Number.isFinite(pack.tokenEstimate) || pack.tokenEstimate <= 0) {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包 tokenEstimate 不合法', remediation: '在 manifest.json 填写正数 tokenEstimate 后重新检查', field: 'tokenEstimate' })
  }
  if (pack.source.trim() === '' || pack.source === 'unknown') {
    issues.push({ code: 'PACK_METADATA_INVALID', message: '技能包没有来源记录', remediation: '在 manifest.json 填写 source 后重新检查', field: 'source' })
  }
  return issues
}

/**
 * Check skill-pack health without touching the filesystem.
 * @param packs - the merged catalog to inspect.
 * @param options - optional single `packId` and detected duplicate ids.
 * @returns per-pack issues and their aggregate status.
 */
export function collectPackHealth(
  packs: ReadonlyMap<string, SkillPack>,
  options: { readonly packId?: string; readonly duplicates?: readonly string[] } = {},
): PackHealth {
  const duplicates = options.duplicates ?? []
  const selected = options.packId === undefined ? [...packs.values()] : [...packs.values()].filter(pack => pack.id === options.packId)
  if (options.packId !== undefined && selected.length === 0) {
    return {
      status: 'error',
      items: [{
        packId: options.packId,
        status: 'error',
        issues: [{
          code: 'SKILL_NOT_FOUND',
          message: `未知技能包：${options.packId}`,
          remediation: '先调用 skill_catalog 或 skill_search 获取有效 packId，再重试',
        }],
      }],
      summary: { total: 1, ok: 0, warning: 0, error: 1 },
    }
  }
  const items = selected.map((pack): PackCheck => {
    const issues: Issue[] = []
    if (pack.content.trim() === '') {
      issues.push({ code: 'PACK_CONTENT_MISSING', message: `技能包 ${pack.id} 的 SKILL.md 为空`, remediation: '补写 SKILL.md 内容后重新运行 skill_check' })
    }
    if (duplicates.includes(pack.id)) {
      issues.push({ code: 'PACK_DUPLICATE', message: `技能包 ${pack.id} 在内置与安装目录重复`, remediation: '移除重复目录或改用新的 id 后重新检查' })
    }
    issues.push(...metadataIssue(pack))
    const errors = issues.some(issue => issue.code === 'PACK_CONTENT_MISSING' || issue.code === 'PACK_DUPLICATE' || issue.field === 'id' || issue.field === 'name' || issue.field === 'description')
    const status = issues.length === 0 ? 'ok' : errors ? 'error' : 'warning'
    return { packId: pack.id, status, issues }
  })
  const ok = items.filter(item => item.status === 'ok').length
  const warning = items.filter(item => item.status === 'warning').length
  const error = items.filter(item => item.status === 'error').length
  return {
    status: error > 0 ? 'error' : warning > 0 ? 'warning' : 'ok',
    items,
    summary: { total: items.length, ok, warning, error },
  }
}

/**
 * Append one failure record to the skill-admin session log. The caller supplies
 * only diagnostics and error text; no prompt body or credential enters here.
 * @param path - `~/.dsh/cadre-skill-admin/session-error.log`.
 * @param error - thrown failure.
 * @param diagnostics - current preset/controller snapshot.
 */
export function appendSessionError(path: string, error: unknown, diagnostics: AdminDiagnostics): void {
  mkdirSync(dirname(path), { recursive: true })
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  appendFileSync(path, `${JSON.stringify({
    time: new Date().toISOString(),
    message,
    ...(stack === undefined ? {} : { stack }),
    diagnostics,
  })}\n`, 'utf8')
}
