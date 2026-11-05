/**
 * Release version-monotonicity gate for `release.mjs` (G6 in
 * 设计-架构输入-运维脚本.md §2.6).
 *
 * A release publishes into `D:\xxw_p\cadre-release\<version>\` and the
 * repository tags releases `v<version>`; a target version that does not
 * strictly exceed every already-published version would either overwrite
 * published bytes or reserve a version the tag set already used. The gate
 * reads both evidence sources and fails closed. Tag existence is NOT a
 * precondition for publishing (that decision belongs to the release owner) —
 * tags only contribute to the published-version lower bound, as do release
 * directory names for evidence gathered before the gate existed.
 */

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Parse one release version, tolerating the `v` tag prefix.
 * @param {string} value - candidate version, for example `1.5.0`, `v1.5.0-rc.1`.
 * @returns {{major: number, minor: number, patch: number, prerelease: string | undefined} | null}
 *   the parsed parts, or null when the value is not a version.
 */
export function parseReleaseVersion(value) {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

/**
 * Order two versions by semver precedence: numeric fields first, then a
 * prerelease ranks below the release it precedes, and prerelease identifiers
 * compare field by field with numeric fields below alphanumeric ones.
 * @param {string} left - one version.
 * @param {string} right - the other version.
 * @returns {number} negative when `left` ranks lower, positive when higher,
 *   zero when equal.
 */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (a === null) throw new Error(`release version gate: cannot compare unparsable version ${JSON.stringify(left)}`)
  if (b === null) throw new Error(`release version gate: cannot compare unparsable version ${JSON.stringify(right)}`)
  const numeric = (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch)
  if (numeric !== 0) return numeric
  if (a.prerelease === undefined || b.prerelease === undefined) {
    if (a.prerelease === b.prerelease) return 0
    return a.prerelease === undefined ? 1 : -1
  }
  const leftFields = a.prerelease.split('.')
  const rightFields = b.prerelease.split('.')
  for (let index = 0; index < Math.max(leftFields.length, rightFields.length); index += 1) {
    const leftField = leftFields[index]
    const rightField = rightFields[index]
    // A shorter identifier list ranks lower once all its fields match.
    if (leftField === undefined) return -1
    if (rightField === undefined) return 1
    if (leftField === rightField) continue
    const leftNumeric = /^\d+$/.test(leftField)
    const rightNumeric = /^\d+$/.test(rightField)
    if (leftNumeric && rightNumeric) return Number(leftField) - Number(rightField)
    // Numeric fields rank below alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftField < rightField ? -1 : 1
  }
  return 0
}

/**
 * Normalize one git tag or release directory name into a comparable version
 * string, or null when it carries no version (helper tags, README files).
 * @param {string} raw - a `git tag --list` line or a directory name.
 * @returns {string | null} the canonical version without the `v` prefix.
 */
function normalizePublishedName(raw) {
  const parsed = parseReleaseVersion(raw)
  if (parsed === null) return null
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}${parsed.prerelease === undefined ? '' : `-${parsed.prerelease}`}`
}

/**
 * Normalize raw published-name evidence (git tag lines, release directory
 * names) into canonical version strings, dropping everything that names no
 * version.
 * @param {string[]} rawNames - tag lines or directory names, `v` prefix allowed.
 * @returns {string[]} canonical published versions, duplicates included.
 */
export function normalizePublishedVersions(rawNames) {
  return rawNames.map(normalizePublishedName).filter((version) => version !== null)
}

/**
 * Collect published-version evidence from tag lines and release-directory
 * names, dropping everything that names no version.
 * @param {object} sources - the two evidence sources release.mjs reads.
 * @param {string[]} [sources.tagLines] - `git tag --list` output lines.
 * @param {string[]} [sources.releaseDirNames] - names of the release-root
 *   directories, one per published version.
 * @returns {string[]} canonical published versions, duplicates included.
 */
export function collectPublishedVersions({ tagLines = [], releaseDirNames = [] }) {
  return normalizePublishedVersions([...tagLines, ...releaseDirNames])
}

/**
 * Return the highest published version, or null when nothing is published.
 * @param {string[]} versions - canonical published versions.
 * @returns {string | null} the maximum, or null for an empty baseline.
 */
export function maxPublishedVersion(versions) {
  if (versions.length === 0) return null
  return versions.reduce((newest, candidate) => compareReleaseVersions(candidate, newest) > 0 ? candidate : newest)
}

/**
 * Fail closed unless `targetVersion` strictly exceeds every published version.
 * Tolerates raw evidence: tag-style `v` prefixes and non-version names are
 * normalized or dropped, so the caller cannot weaken the gate by its input shape.
 * @param {string} targetVersion - the version about to be built and published.
 * @param {string[]} publishedVersions - raw published names (tags and release
 *   directories combined).
 * @returns {string | null} the canonical published maximum the target was
 *   checked against, or null when nothing is published yet.
 * @throws {Error} when the target is unparsable or does not rank above the
 *   published maximum.
 */
export function assertVersionMonotonic(targetVersion, publishedVersions) {
  if (parseReleaseVersion(targetVersion) === null) {
    throw new Error(`release version gate: unparsable target version ${JSON.stringify(targetVersion)}`)
  }
  const max = maxPublishedVersion(normalizePublishedVersions(publishedVersions))
  if (max !== null && compareReleaseVersions(targetVersion, max) <= 0) {
    throw new Error(`release version gate: target ${targetVersion} is not strictly higher than published max ${max}`)
  }
  return max
}
