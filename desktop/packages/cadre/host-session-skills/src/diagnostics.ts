/**
 * Read-only diagnostics for the skills-page administrator. This module never
 * writes skill files; the route decides whether a failure should append the
 * session-error log.
 * @module
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
/** SPDX identifiers the health check accepts; anything else is reported as non-SPDX. */
const SPDX_IDS = new Set([
  '0BSD', 'AGPL-3.0-only', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC0-1.0', 'CC-BY-4.0',
  'EPL-2.0', 'GPL-2.0-only', 'GPL-3.0-only', 'ISC', 'LGPL-2.1-only', 'LGPL-3.0-only', 'MIT', 'MPL-2.0',
  'Unlicense', 'Zlib',
])
/** Roles the roster model understands; anything else cannot be selected by a member. */
const KNOWN_ROLES = new Set(['supervisor', 'worker'])
/** Largest token estimate a pack may declare before `skill_check` reports it. */
const MAX_TOKEN_ESTIMATE = 20_000

/** Manifest fields before validation, read from untrusted JSON. */
interface RawMetadata {
  readonly id: unknown
  readonly name: unknown
  readonly description: unknown
  readonly license: unknown
  readonly roles: unknown
  readonly tokenEstimate: unknown
  readonly source: unknown
  readonly tools: unknown
  readonly content: string
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Validate manifest metadata shared by the on-disk check and the admin diagnostics.
 * @param raw - manifest fields as read, so invalid values are reported rather than dropped.
 * @returns one Chinese, actionable issue per violated rule.
 */
function metadataIssues(raw: RawMetadata): Issue[] {
  const issues: Issue[] = []
  const report = (message: string, remediation: string, field: string): void => {
    issues.push({ code: 'PACK_METADATA_INVALID', message, remediation, field })
  }
  const id = textOf(raw.id)
  if (id === '') {
    report('技能包缺少 id', '在 manifest.json 填写 1-64 位 kebab-case 的 id 后重新检查', 'id')
  } else if (!KEBAB_ID.test(id) || id.length > 64) {
    report(`技能包 id ${id} 不是 1-64 位 kebab-case`, '把目录名与 manifest.json 的 id 改成 1-64 位 kebab-case 后重新检查', 'id')
  }
  if (textOf(raw.name).trim() === '') {
    report('技能包缺少名称', '在 manifest.json 填写非空 name 后重新检查', 'name')
  }
  if (textOf(raw.description).trim() === '') {
    report('技能包缺少描述', '在 manifest.json 填写非空 description 后重新检查', 'description')
  }
  const license = textOf(raw.license)
  if (LICENSES_MISSING.has(license.trim())) {
    report('技能包未声明许可证', '在 manifest.json 填写 license（如 MIT）后重新检查', 'license')
  } else if (!SPDX_IDS.has(license.trim())) {
    report(`技能包许可证 ${license} 不是 SPDX 标识`, '把 manifest.json 的 license 改成 SPDX 标识（如 MIT、Apache-2.0）后重新检查', 'license')
  }
  const roles = listOf(raw.roles).map(textOf).filter(role => role !== '')
  const unknownRoles = roles.filter(role => !KNOWN_ROLES.has(role))
  if (roles.length === 0) {
    report('技能包没有可用角色', '在 manifest.json 的 roles 中补 supervisor 或 worker 后重新检查', 'roles')
  } else if (unknownRoles.length > 0) {
    report(`技能包 roles 含未知角色：${unknownRoles.join('、')}`, '把 manifest.json 的 roles 限定为 supervisor 或 worker 后重新检查', 'roles')
  }
  const tokenEstimate = typeof raw.tokenEstimate === 'number' ? raw.tokenEstimate : Number.NaN
  if (!Number.isFinite(tokenEstimate) || tokenEstimate <= 0) {
    report('技能包 tokenEstimate 不合法', '在 manifest.json 填写正数 tokenEstimate 后重新检查', 'tokenEstimate')
  } else if (tokenEstimate > MAX_TOKEN_ESTIMATE) {
    report(
      `技能包 tokenEstimate ${String(tokenEstimate)} 超出上限 ${String(MAX_TOKEN_ESTIMATE)}`,
      '精简 SKILL.md 或调低 manifest.json 的 tokenEstimate 后重新检查',
      'tokenEstimate',
    )
  }
  const source = textOf(raw.source)
  if (source.trim() === '' || source === 'unknown') {
    report('技能包没有来源记录', '在 manifest.json 填写 source 后重新检查', 'source')
  }
  const unused = listOf(raw.tools).map(textOf).filter(tool => tool !== '' && !raw.content.includes(tool))
  if (unused.length > 0) {
    report(
      `manifest 声明的工具未在 SKILL.md 说明：${unused.join('、')}`,
      '在 SKILL.md 说明这些工具的用途，或从 manifest.json 的 tools 中移除后重新检查',
      'tools',
    )
  }
  return issues
}

function metadataIssue(pack: SkillPack): Issue[] {
  return metadataIssues({
    id: pack.id,
    name: pack.name,
    description: pack.description,
    license: pack.license,
    roles: pack.roles,
    tokenEstimate: pack.tokenEstimate,
    source: pack.source,
    tools: pack.tools,
    content: pack.content,
  })
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

/** Filesystem inputs for the conversational `skill_check` tool. */
export interface CatalogCheckOptions {
  readonly skillsDir: string
  readonly builtinDir?: string | undefined
  readonly packId?: string | undefined
}

function missingDirectory(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Check the on-disk catalog: readable roots, parseable manifests, content, metadata,
 * duplicate ids, and declared tools that the SKILL.md never mentions.
 * @param options - installed and builtin roots plus an optional single pack id.
 * @returns per-pack health with only actionable Chinese issues.
 */
export function checkSkillCatalog(options: CatalogCheckOptions): PackHealth {
  const roots: { readonly dir: string; readonly origin: 'builtin' | 'installed' }[] = []
  if (options.builtinDir !== undefined) roots.push({ dir: options.builtinDir, origin: 'builtin' })
  roots.push({ dir: options.skillsDir, origin: 'installed' })
  const seeds: { readonly packId: string; readonly issues: readonly Issue[] }[] = []
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root.dir)
    } catch (error) {
      if (missingDirectory(error)) continue
      return {
        status: 'error',
        items: [{
          packId: options.packId ?? root.dir,
          status: 'error',
          issues: [{
            code: 'SKILL_SEARCH_UNAVAILABLE',
            message: `技能目录 ${root.dir} 不可读`,
            remediation: '检查技能目录权限后重试；恢复读取后重新运行 skill_check',
          }],
        }],
        summary: { total: 1, ok: 0, warning: 0, error: 1 },
      }
    }
    for (const name of entries) {
      const dir = join(root.dir, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const manifest = join(dir, 'manifest.json')
      if (!existsSync(manifest)) continue
      let record: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
        record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined
      } catch {
        record = undefined
      }
      if (record === undefined) {
        seeds.push({
          packId: name,
          issues: [{
            code: 'PACK_MANIFEST_INVALID',
            message: `技能包 ${name} 的 manifest.json 无法解析`,
            remediation: '修正 manifest.json 的 JSON 语法后重新检查',
          }],
        })
        continue
      }
      let content = ''
      try {
        content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      } catch {
        // A missing SKILL.md is reported as empty content below.
      }
      const declaredId = textOf(record.id).trim() === '' ? name : textOf(record.id)
      const issues: Issue[] = []
      if (content.trim() === '') {
        issues.push({
          code: 'PACK_CONTENT_MISSING',
          message: `技能包 ${declaredId} 的 SKILL.md 为空`,
          remediation: '补写 SKILL.md 内容后重新运行 skill_check',
        })
      }
      issues.push(...metadataIssues({
        id: record.id,
        name: record.name,
        description: record.description,
        license: record.license,
        roles: record.roles,
        tokenEstimate: record.tokenEstimate,
        source: record.source,
        tools: record.tools,
        content,
      }))
      seeds.push({ packId: declaredId, issues })
    }
  }
  const grouped = new Map<string, Issue[]>()
  for (const seed of seeds) {
    const issues = grouped.get(seed.packId)
    if (issues === undefined) {
      grouped.set(seed.packId, [...seed.issues])
      continue
    }
    issues.push(...seed.issues.filter(issue => !issues.some(existing => existing.code === issue.code && existing.message === issue.message)))
  }
  const items = [...grouped]
    .filter(([packId]) => options.packId === undefined || packId === options.packId)
    .map(([packId, seedIssues]): PackCheck => {
      const issues = [...seedIssues]
      const occurrences = seeds.filter(seed => seed.packId === packId).length
      if (occurrences > 1) {
        issues.push({
          code: 'PACK_DUPLICATE',
          message: `技能 id ${packId} 在技能目录中出现了 ${String(occurrences)} 次`,
          remediation: '删除或重命名重复的技能目录，确保每个 id 只出现一次后重新检查',
          field: 'id',
        })
      }
      const errors = issues.some(issue => issue.code === 'PACK_CONTENT_MISSING'
        || issue.code === 'PACK_DUPLICATE' || issue.code === 'PACK_MANIFEST_INVALID'
        || issue.field === 'id' || issue.field === 'name' || issue.field === 'description')
      const status = issues.length === 0 ? 'ok' : errors ? 'error' : 'warning'
      return { packId, status, issues }
    })
    .sort((left, right) => left.packId.localeCompare(right.packId))
  if (items.length === 0 && options.packId !== undefined) {
    items.push({
      packId: options.packId,
      status: 'error',
      issues: [{
        code: 'SKILL_NOT_FOUND',
        message: `未知技能包：${options.packId}`,
        remediation: '先调用 skill_catalog 或 skill_search 获取有效 packId，再重试',
      }],
    })
  }
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
