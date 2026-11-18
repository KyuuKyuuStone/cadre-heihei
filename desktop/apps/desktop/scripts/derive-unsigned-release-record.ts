/**
 * Derive the unsigned prerelease completion record from the machine-written packaging run.
 *
 * Unsigned packaging deliberately writes no `<target>-release.json` (that record is the signed
 * channel flow's deliverable), while the GitHub prerelease script refuses to publish without one
 * beside the installer. This step reads the newest unsigned packaging run for a target — the
 * machine-written run.json names the commit, version, and cleanliness the installer was built
 * from — and writes the identity-only record beside the installer. It never touches the network
 * and never accepts a commit id from the operator, so the record stays a build fact instead of a
 * typed-in claim.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopBuildRecordFilename, type DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

const USAGE = `Usage: tsx scripts/derive-unsigned-release-record.ts <target> [--build-root <dir>]

Derives <target>-release.json beside the unsigned installer from the newest
unsigned packaging run under packaging-runs/. The record names the commit that
run recorded, so no operator types a commit id. Dirty, failed, unfinished,
directory-only, prepare-only, and installer-less runs are refused.`

/** A full lowercase git commit id. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u

/** Installer file extension the GitHub prerelease flow ships for one target. */
const INSTALLER_EXTENSIONS: Record<DesktopAutoUpdateTarget, string> = {
  'mac-arm64': '.dmg',
  'mac-x64': '.dmg',
  'win-x64': '.exe',
}

const TARGETS: readonly DesktopAutoUpdateTarget[] = ['mac-arm64', 'mac-x64', 'win-x64']

/** Parsed command line for the derive step. */
export interface DeriveRecordArgs {
  /** Supported Desktop release target to derive the record for. */
  readonly target: DesktopAutoUpdateTarget
  /** Build tree root holding `targets/` and `packaging-runs/`; defaults to the app build root. */
  readonly buildRoot?: string
}

/** Options for {@link deriveUnsignedReleaseRecord}. */
export interface DeriveUnsignedReleaseRecordOptions extends DeriveRecordArgs {
  /** Log seam for tests; defaults to console.log. */
  readonly log?: (message: string) => void
}

/** What the derive step wrote, with the run and installer it proved. */
export interface DerivedUnsignedReleaseRecord {
  /** Record file written beside the installer. */
  readonly recordPath: string
  /** Installer the record was derived beside. */
  readonly installer: string
  /** Installer size in bytes. */
  readonly installerSize: number
  /** Version the record names, equal to the recorded build version. */
  readonly version: string
  /** Full commit id the record names, equal to the recorded packaged commit. */
  readonly commit: string
  /** Packaging run directory the record was derived from. */
  readonly runDirectory: string
}

/**
 * Validate the command line into derive options.
 * @param argv - Command line after the script name.
 * @returns The target and optional build root.
 */
export function parseDeriveRecordArgs(argv: readonly string[]): DeriveRecordArgs {
  let target: string | undefined
  let buildRoot: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--build-root') {
      const value = argv[index + 1]
      if (value === undefined) fail(`--build-root requires a directory\n\n${USAGE}`)
      buildRoot = value
      index += 1
      continue
    }
    if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`)
    if (target !== undefined) fail(`unexpected argument ${arg}; one target is accepted\n\n${USAGE}`)
    target = arg
  }
  if (target === undefined || !isDesktopTarget(target)) {
    fail(`name one supported target: ${TARGETS.join(', ')}\n\n${USAGE}`)
  }
  return buildRoot === undefined ? { target } : { target, buildRoot }
}

/**
 * Derive and write the unsigned prerelease completion record beside the installer.
 * @param options - Target, optional build root, and log seam.
 * @returns The record path with the run, version, commit, and installer it was derived from.
 */
export function deriveUnsignedReleaseRecord(options: DeriveUnsignedReleaseRecordOptions): DerivedUnsignedReleaseRecord {
  const log = options.log ?? ((message: string) => console.log(message))
  const paths = desktopTargetBuildPaths(options.target, options.buildRoot === undefined ? undefined : resolve(options.buildRoot))
  const run = newestUnsignedPackagingRun(paths.packagingRuns, options.target, log)
  const installer = resolveUnsignedInstaller(paths.unsignedArtifacts, options.target, run.version)
  const recordPath = join(paths.unsignedArtifacts, desktopBuildRecordFilename(options.target))
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    target: options.target,
    version: run.version,
    commit: run.commit,
    dirty: false,
  }, null, 2)}\n`
  const existing = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : undefined
  if (existing === contents) {
    log(`desktop record: ${basename(recordPath)} already names ${run.version} @ ${run.commit.slice(0, 12)}`)
  }
  else {
    if (existing !== undefined) log(`desktop record: replacing the record at ${recordPath}`)
    const temporaryPath = `${recordPath}.tmp`
    writeFileSync(temporaryPath, contents)
    renameSync(temporaryPath, recordPath)
    log(`desktop record: wrote ${recordPath}`)
  }
  log(`desktop record: ${options.target} ${run.version} @ ${run.commit.slice(0, 12)} from ${run.name}`)
  log(`desktop record: installer ${basename(installer.path)} (${installer.size} B)`)
  return {
    recordPath,
    installer: installer.path,
    installerSize: installer.size,
    version: run.version,
    commit: run.commit,
    runDirectory: run.directory,
  }
}

/** One usable packaging-run entry: the parsed record plus the ordering key and provenance. */
interface PackagingRunCandidate {
  readonly name: string
  readonly directory: string
  readonly startedAtMs: number
  readonly run: Record<string, unknown>
}

/** The selected run after its release-relevant fields passed validation. */
interface SelectedPackagingRun {
  readonly name: string
  readonly directory: string
  readonly version: string
  readonly commit: string
}

/**
 * Pick the newest unsigned run for the target and validate it end to end.
 * Unusable run directories are skipped with a note; runs for other targets or
 * modes are ignored; the newest matching run is validated strictly and never
 * falls back to an older one, because electron-builder overwrites the installer
 * directory on every run.
 * @param runsRoot - Directory holding one subdirectory per packaging run.
 * @param target - Supported Desktop release target.
 * @param log - Log seam for skip notes.
 * @returns The validated run naming the version and commit to record.
 */
function newestUnsignedPackagingRun(
  runsRoot: string,
  target: DesktopAutoUpdateTarget,
  log: (message: string) => void,
): SelectedPackagingRun {
  if (!existsSync(runsRoot)) {
    fail(`desktop record: no packaging runs at ${runsRoot}; package ${target} with --unsigned first`)
  }
  const candidates: PackagingRunCandidate[] = []
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(runsRoot, entry.name)
    const run = readRunRecord(directory, entry.name, log)
    if (run === undefined) continue
    if (run.record.target !== target || run.record.unsigned !== true) continue
    candidates.push({ name: entry.name, directory, startedAtMs: run.startedAtMs, run: run.record })
  }
  const newest = candidates.sort((first, second) => second.startedAtMs - first.startedAtMs)[0]
  if (newest === undefined) {
    fail(`desktop record: no unsigned packaging run for ${target} under ${runsRoot}; package ${target} with --unsigned first`)
  }
  return validateSelectedRun(newest, target)
}

/**
 * Read one run's run.json, skipping the entry with a note when it is not a usable run record.
 * @param directory - Packaging run directory.
 * @param name - Packaging run directory name, for messages.
 * @param log - Log seam for skip notes.
 * @returns The parsed record and its parseable start time, or undefined when the entry is unusable.
 */
function readRunRecord(
  directory: string,
  name: string,
  log: (message: string) => void,
): { readonly record: Record<string, unknown>, readonly startedAtMs: number } | undefined {
  const runPath = join(directory, 'run.json')
  if (!existsSync(runPath)) {
    log(`desktop record: skipping ${name}; the run directory has no run.json`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(runPath, 'utf8'))
  }
  catch (error) {
    log(`desktop record: skipping ${name}; run.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log(`desktop record: skipping ${name}; run.json must hold a JSON object`)
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const startedAt = record.startedAt
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
    log(`desktop record: skipping ${name}; run.json has an unreadable startedAt`)
    return undefined
  }
  return { record, startedAtMs: Date.parse(startedAt) }
}

/**
 * Validate the release-relevant fields of the selected run before deriving from it.
 * @param candidate - The newest unsigned run for the target.
 * @param target - Supported Desktop release target.
 * @returns The run naming a version, a full commit id, and a successful result.
 */
function validateSelectedRun(candidate: PackagingRunCandidate, target: DesktopAutoUpdateTarget): SelectedPackagingRun {
  const { name, run } = candidate
  if (run.prepareOnly === true) {
    fail(`desktop record: packaging run ${name} only prepared the runtime and produced no installer; package ${target} with --unsigned`)
  }
  if (run.directory === true) {
    fail(`desktop record: packaging run ${name} built a bare directory and produced no installer; package ${target} with --unsigned`)
  }
  if (run.dirty === true) {
    fail(`desktop record: packaging run ${name} was packaged from a dirty checkout; rebuild from a clean checkout before deriving a release record`)
  }
  const version = run.version
  if (typeof version !== 'string' || version === '') {
    fail(`desktop record: packaging run ${name} names no version; rebuild ${target} with --unsigned`)
  }
  const commit = run.commit
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    fail(`desktop record: packaging run ${name} names no full commit id; rebuild ${target} with --unsigned so the run records the packaged commit`)
  }
  const resultPath = join(candidate.directory, 'result.json')
  if (!existsSync(resultPath)) {
    fail(`desktop record: packaging run ${name} recorded no result; it is still running or was interrupted — wait for it or rebuild ${target} with --unsigned`)
  }
  const result = readJsonObject(resultPath)
  if (result.success !== true) {
    fail(`desktop record: packaging run ${name} did not complete successfully; rebuild ${target} with --unsigned before deriving a release record`)
  }
  return { name, directory: candidate.directory, version, commit }
}

/**
 * Find the one installer of the recorded version in the target's unsigned artifacts.
 * @param artifactsDirectory - The target's unsigned-artifacts directory.
 * @param target - Supported Desktop release target.
 * @param version - Version recorded by the selected packaging run.
 * @returns The installer path and its size in bytes.
 */
function resolveUnsignedInstaller(
  artifactsDirectory: string,
  target: DesktopAutoUpdateTarget,
  version: string,
): { readonly path: string, readonly size: number } {
  const extension = INSTALLER_EXTENSIONS[target]
  if (!existsSync(artifactsDirectory)) {
    fail(`desktop record: no unsigned artifacts at ${artifactsDirectory}; package ${target} with --unsigned first`)
  }
  // The version must be filename-delimited, so 1.5.4 never matches a 1.5.40 installer.
  const versionPattern = new RegExp(`-${escapeRegExp(version)}[-.]`, 'u')
  const installers = readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(extension) && versionPattern.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (installers.length === 0) {
    fail(`desktop record: no ${extension} installer naming version ${version} in ${artifactsDirectory}; package ${target} with --unsigned`)
  }
  if (installers.length > 1) {
    fail(`desktop record: ${installers.length} ${extension} installers name version ${version} in ${artifactsDirectory}: ${installers.join(', ')}; keep one installer for the release`)
  }
  const installerName = installers[0]
  if (installerName === undefined) fail(`desktop record: installer selection failed for ${version} in ${artifactsDirectory}`)
  const installerPath = join(artifactsDirectory, installerName)
  const size = statSync(installerPath).size
  if (size === 0) {
    fail(`desktop record: installer ${installerName} is empty; rebuild ${target} with --unsigned`)
  }
  const blockmapPath = `${installerPath}.blockmap`
  if (!existsSync(blockmapPath)) {
    fail(`desktop record: no ${installerName}.blockmap beside the installer; rebuild ${target} with --unsigned so the release ships delta updates`)
  }
  return { path: installerPath, size }
}

/**
 * Read a JSON file that must hold an object.
 * @param path - File to read.
 * @returns The parsed object.
 */
function readJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (error) {
    fail(`desktop record: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`desktop record: ${path} must hold a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Check whether a string names one of the supported Desktop release targets.
 * @param value - Candidate target name.
 * @returns Whether the value is a supported target name.
 */
function isDesktopTarget(value: string): value is DesktopAutoUpdateTarget {
  return (TARGETS as readonly string[]).includes(value)
}

/**
 * Escape a version string for literal use inside a regular expression.
 * @param value - Plain string to match literally.
 * @returns Source for a regular expression that matches the string literally.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Stop the derive step with the rule that refused it.
 * @param message - Operator-facing failure message.
 */
function fail(message: string): never {
  throw new Error(message)
}

function main(): number {
  try {
    deriveUnsignedReleaseRecord(parseDeriveRecordArgs(process.argv.slice(2)))
    return 0
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
