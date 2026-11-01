/**
 * Read-only diagnostics for the skills-page administrator. This module never
 * writes skill files; the route decides whether a failure should append the
 * session-error log.
 * @module
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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

/** Inputs collected from the Host before rendering diagnostics. */
export interface DiagnosticsInput {
  readonly presetId: string
  readonly presets: PresetDiagnosticsPort | undefined
  readonly sessionController: unknown
  readonly adminService: unknown
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
