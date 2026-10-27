/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
    /** Whether the GitHub Releases availability check may make network requests. */
    readonly checkForUpdates: boolean
    /** Last app version that completed startup; drives the one-time upgrade notice. */
    readonly lastSeenVersion?: string
  }
}

const DEFAULTS: DesktopSettings = {
  updates: { allowTestAuthPopupWindow: false, checkForUpdates: true },
}

function settingsPath(userData: string): string {
  return join(userData, 'desktop', 'settings.json')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = settingsPath(userData)
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value) || (value.updates !== undefined && !record(value.updates))) {
      throw new Error('expected a JSON object with an optional updates object')
    }
    const allow = value.updates?.allowTestAuthPopupWindow
    if (allow !== undefined && typeof allow !== 'boolean') {
      throw new Error('updates.allowTestAuthPopupWindow must be true or false')
    }
    const checkForUpdates = value.updates?.checkForUpdates
    if (checkForUpdates !== undefined && typeof checkForUpdates !== 'boolean') {
      throw new Error('updates.checkForUpdates must be true or false')
    }
    const lastSeenVersion = value.updates?.lastSeenVersion
    if (lastSeenVersion !== undefined && typeof lastSeenVersion !== 'string') {
      throw new Error('updates.lastSeenVersion must be text')
    }
    return {
      updates: {
        allowTestAuthPopupWindow: allow ?? false,
        checkForUpdates: checkForUpdates ?? true,
        ...(lastSeenVersion === undefined ? {} : { lastSeenVersion }),
      },
    }
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return DEFAULTS
  }
}

/**
 * Merge one updates patch into the existing shell settings document.
 * Unknown top-level keys survive; an unreadable document is replaced only when
 * the caller explicitly changes a setting.
 * @param userData - Electron's userData directory.
 * @param patch - Update preferences to persist; omitted fields keep their value.
 * @returns The document as re-read after the write.
 */
export function writeDesktopSettings(
  userData: string,
  patch: Partial<DesktopSettings['updates']>,
): DesktopSettings {
  const path = settingsPath(userData)
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (record(parsed)) value = parsed
  } catch (_error) {
    // Missing or invalid documents start from the defaults below.
  }
  const current = record(value.updates) ? value.updates : {}
  const updates = { ...current, ...patch }
  mkdirSync(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ ...value, updates }, null, 2)}\n`, { mode: 0o600 })
  return readDesktopSettings(userData)
}
