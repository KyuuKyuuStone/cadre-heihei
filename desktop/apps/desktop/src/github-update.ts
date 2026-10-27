/**
 * Lightweight GitHub Releases availability check.
 *
 * This is deliberately separate from the updater: it only tells the user that
 * a newer release exists and opens the public releases page. It never
 * downloads, installs, or blocks the application.
 */
import type { CadreUpdateNotice } from './ipc.ts'
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './settings.ts'

/** Public release page opened by the notice. */
export const CADRE_RELEASES_URL = 'https://github.com/KyuuKyuuStone/cadre-heihei/releases/latest'

/** GitHub latest-release endpoint; unauthenticated requests are limited to 60/hour/IP. */
const PUBLIC_LATEST_RELEASE_API = 'https://api.github.com/repos/KyuuKyuuStone/cadre-heihei/releases/latest'
const configuredLatestReleaseApi = process.env.DSH_CADRE_UPDATE_API?.trim()
/**
 * Optional local endpoint for development and release smoke tests. Production
 * launches leave it unset; it can only redirect this one read-only request.
 */
export const CADRE_LATEST_RELEASE_API = configuredLatestReleaseApi === undefined || configuredLatestReleaseApi === ''
  ? PUBLIC_LATEST_RELEASE_API
  : configuredLatestReleaseApi

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const IDENTIFIER_PATTERN = /^\d+$/
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5_000

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

/** One check result; callers treat every non-available result as "nothing to show". */
export type GitHubReleaseCheck =
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'current'; readonly version: string }
  | { readonly kind: 'skipped'; readonly reason: 'invalid' | 'network' | 'response' | 'timeout' }

/** Validate and parse one version or release tag. */
export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(input.trim())
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return { core: [major, minor, patch], prerelease }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = IDENTIFIER_PATTERN.test(left)
  const rightNumeric = IDENTIFIER_PATTERN.test(right)
  if (leftNumeric && rightNumeric) {
    const a = Number(left)
    const b = Number(right)
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Compare two semantic versions. Build metadata is ignored, a release outranks
 * its prereleases, and numeric prerelease identifiers compare numerically.
 * @throws when either input is not a supported version.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) throw new Error('invalid version')
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const difference = compareIdentifiers(a.prerelease[index] ?? '', b.prerelease[index] ?? '')
    if (difference !== 0) return difference
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1
}

/** Whether `latest` is newer than `current`; invalid input never counts as newer. */
export function isNewerVersion(latest: string, current: string): boolean {
  if (parseVersion(latest) === null || parseVersion(current) === null) return false
  return compareVersions(latest, current) > 0
}

/** Options for one network check. */
export interface CheckLatestReleaseOptions {
  readonly currentVersion: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ask GitHub for the latest release. Every failure is silent: timeout, network,
 * non-2xx, malformed JSON, and malformed tags all return `skipped`.
 * @param options - current version and optional test seams.
 * @returns `available`, `current`, or a silent `skipped` reason.
 */
export async function checkLatestRelease(options: CheckLatestReleaseOptions): Promise<GitHubReleaseCheck> {
  const current = options.currentVersion.trim().replace(/^v/, '')
  if (parseVersion(current) === null) return { kind: 'skipped', reason: 'invalid' }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl ?? fetch)(CADRE_LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cadre-heihei',
      },
      signal: controller.signal,
    })
    if (!response.ok) return { kind: 'skipped', reason: 'response' }
    const body: unknown = await response.json()
    const tag = record(body) ? body.tag_name : undefined
    if (typeof tag !== 'string') return { kind: 'skipped', reason: 'invalid' }
    const latest = tag.trim().replace(/^v/, '')
    if (parseVersion(latest) === null) return { kind: 'skipped', reason: 'invalid' }
    return isNewerVersion(latest, current)
      ? { kind: 'available', version: latest }
      : { kind: 'current', version: latest }
  } catch (_error) {
    return { kind: 'skipped', reason: controller.signal.aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timeout)
  }
}

/** Main-process owner of the preference, schedule, and current notice. */
export interface GitHubUpdateServiceOptions {
  readonly userData: string
  readonly currentVersion: string
  /** Whether the ledger or session history proves this is an upgraded install, not a new one. */
  readonly hasTeamData: () => boolean
  /** Receives the visible notice, or null when it is dismissed or resolved. */
  readonly publish: (notice: CadreUpdateNotice | null) => void
  /** Test seam for the network call. */
  readonly checkRelease?: typeof checkLatestRelease
  /** Test seam for the interval. */
  readonly intervalMs?: number
}

/**
 * Owns the on/off preference, the one-shot upgrade notice, and the daily check.
 * A failed check is dropped; the next interval tries again.
 */
export class GitHubUpdateService {
  #settings: DesktopSettings
  #available: CadreUpdateNotice | null = null
  #upgraded: CadreUpdateNotice | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #checking: Promise<void> | undefined
  #started = false
  #stopped = false

  constructor(private readonly options: GitHubUpdateServiceOptions) {
    this.#settings = readDesktopSettings(options.userData)
  }

  /** Whether the user allows network checks. */
  get enabled(): boolean {
    return this.#settings.updates.checkForUpdates
  }

  /** The single notice the renderer should show, upgrade notice first. */
  get notice(): CadreUpdateNotice | null {
    return this.#upgraded ?? this.#available
  }

  /** Show the upgrade notice once and start the first daily check. */
  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    this.#announceUpgrade()
    if (this.enabled) {
      void this.check()
      this.#schedule()
    }
  }

  /** Stop all timers; safe to call more than once. */
  stop(): void {
    this.#stopped = true
    this.#clearTimer()
  }

  /**
   * Persist the switch. Disabling cancels the timer and the availability notice;
   * enabling checks immediately and rearms the daily interval.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.#settings = writeDesktopSettings(this.options.userData, { checkForUpdates: enabled })
    if (!enabled) {
      this.#clearTimer()
      this.#available = null
      this.#publish()
      return
    }
    await this.check()
    if (!this.#stopped && this.enabled) this.#schedule()
  }

  /** Dismiss one notice kind without changing the preference. */
  dismiss(kind: CadreUpdateNotice['kind']): void {
    if (kind === 'upgraded') this.#upgraded = null
    else this.#available = null
    this.#publish()
  }

  /** Run one check; concurrent callers share the in-flight request. */
  async check(): Promise<void> {
    if (this.#stopped || !this.enabled) return
    if (this.#checking !== undefined) return this.#checking
    this.#checking = (async () => {
      let result: GitHubReleaseCheck
      try {
        result = await (this.options.checkRelease ?? checkLatestRelease)({
          currentVersion: this.options.currentVersion,
        })
      } catch (_error) {
        // A checker failure is indistinguishable from a blocked network here:
        // drop the round silently and let the next interval try again.
        return
      }
      if (this.#stopped || !this.enabled) return
      if (result.kind === 'available') {
        this.#available = { kind: 'available', version: result.version, url: CADRE_RELEASES_URL }
        this.#publish()
      } else if (result.kind === 'current') {
        this.#available = null
        this.#publish()
      }
      // A skipped result keeps any notice already on screen and silently waits
      // for the next interval; a transient failure must never interrupt work.
    })().finally(() => { this.#checking = undefined })
    return this.#checking
  }

  #announceUpgrade(): void {
    const previous = this.#settings.updates.lastSeenVersion
    if (previous === this.options.currentVersion) return
    if (this.options.hasTeamData()) {
      this.#upgraded = {
        kind: 'upgraded',
        version: this.options.currentVersion,
        ...(previous === undefined ? {} : { fromVersion: previous }),
      }
      this.#publish()
    }
    try {
      this.#settings = writeDesktopSettings(this.options.userData, { lastSeenVersion: this.options.currentVersion })
    } catch (error) {
      // A read-only profile must not turn an optional notice into a startup failure.
      console.warn('desktop update: could not record the seen version', error)
    }
  }

  #schedule(): void {
    this.#clearTimer()
    if (this.#stopped || !this.enabled) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.check().finally(() => { if (!this.#stopped && this.enabled) this.#schedule() })
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.#timer.unref()
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #publish(): void {
    this.options.publish(this.notice)
  }
}
