/** One parsed release version. */
export interface ReleaseVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | undefined
}

/**
 * Parse one release version, tolerating the `v` tag prefix.
 * @param value - Candidate version, for example `1.5.0`, `v1.5.0-rc.1`.
 * @returns The parsed parts, or null when the value is not a version.
 */
export function parseReleaseVersion(value: string): ReleaseVersion | null

/**
 * Order two versions by semver precedence: numeric fields first, then a
 * prerelease ranks below the release it precedes, and prerelease identifiers
 * compare field by field with numeric fields below alphanumeric ones.
 * @param left - One version.
 * @param right - The other version.
 * @returns Negative when `left` ranks lower, positive when higher, zero when equal.
 */
export function compareReleaseVersions(left: string, right: string): number

/**
 * Normalize raw published-name evidence (git tag lines, release directory
 * names) into canonical version strings, dropping everything that names no
 * version.
 * @param rawNames - Tag lines or directory names, `v` prefix allowed.
 * @returns Canonical published versions, duplicates included.
 */
export function normalizePublishedVersions(rawNames: readonly string[]): string[]

/**
 * Collect published-version evidence from tag lines and release-directory
 * names, dropping everything that names no version.
 * @param sources - The two evidence sources release.mjs reads.
 * @returns Canonical published versions, duplicates included.
 */
export function collectPublishedVersions(sources: {
  readonly tagLines?: readonly string[]
  readonly releaseDirNames?: readonly string[]
}): string[]

/**
 * Return the highest published version, or null when nothing is published.
 * @param versions - Canonical published versions.
 * @returns The maximum, or null for an empty baseline.
 */
export function maxPublishedVersion(versions: readonly string[]): string | null

/**
 * Fail closed unless the target strictly exceeds every published version.
 * @param targetVersion - The version about to be built and published.
 * @param publishedVersions - Raw published names (tags and release directories combined).
 * @returns The canonical published maximum the target was checked against, or null when nothing is published yet.
 * @throws {Error} When the target is unparsable or does not rank above the published maximum.
 */
export function assertVersionMonotonic(targetVersion: string, publishedVersions: readonly string[]): string | null
