/**
 * Publish one desktop release on GitHub Releases after proving tag, release target, and packaged
 * commit are the same commit; the default marks a prerelease and --latest publishes a full release.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `usage:
  pnpm exec tsx scripts/desktop-github-release.ts <installer> [more assets...] --notes-file <markdown>
      [--title <title>] [--repository <owner/name>] [--latest] [--dry-run]

The first asset is the installer; its sibling <target>-release.json completion record names the
packaged commit. An adjacent <installer>.blockmap is uploaded with the installer automatically.
Every publish proves three identities before writing anything: the packaged commit from the
completion record, the remote tag v<version>, and the GitHub release targetCommitish.
The default publish marks a prerelease; --latest publishes a full release instead.`

/** GitHub repository that hosts the public prereleases the desktop update check reads. */
export const DESKTOP_GITHUB_REPOSITORY = 'KyuuKyuuStone/cadre-heihei'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const TARGET_SEGMENT_PATTERN = /-(win-x64|mac-arm64|mac-x64)(?:[-.\s]|$)/
const VERSION_SEGMENT_PATTERN = /-(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)-(?:win-x64|mac-arm64|mac-x64)(?:[-.\s]|$)/

/** One local file the release will upload. */
export interface DesktopGithubReleaseAsset {
  readonly path: string
  readonly name: string
  readonly size: number
}

/** Everything a publish needs after local and remote validation pass. */
export interface DesktopGithubReleasePlan {
  readonly repository: string
  readonly target: string
  readonly version: string
  readonly commit: string
  readonly tag: string
  readonly title: string
  readonly notesFile: string
  /** Whether gh marks the release as a prerelease; the --latest flag publishes a full release instead. */
  readonly prerelease: boolean
  readonly assets: readonly DesktopGithubReleaseAsset[]
}

/** Exit status, stdout, and stderr of one gh invocation. */
export interface GhResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Subprocess seam for gh so tests script remote state without a network. */
export type GhRunner = (args: readonly string[]) => GhResult

/** Options accepted by the release entry point. */
export interface DesktopGithubReleaseOptions {
  readonly run?: GhRunner
  readonly log?: (message: string) => void
}

/** Outcome of one release attempt; failed attempts carry the exact rule that stopped the run. */
export interface DesktopGithubReleaseResult {
  readonly ok: boolean
  readonly message: string
  readonly recovery?: readonly string[]
  readonly plan?: DesktopGithubReleasePlan
}

class DesktopGithubReleaseRuleError extends Error {}

/** Exception raised by the real gh runner when gh itself cannot run. */
class GhUnavailableError extends Error {}

interface DesktopCompletionRecord {
  readonly schemaVersion: number
  readonly target: string
  readonly version: string
  readonly commit: string
  readonly dirty: boolean
}

interface TagRef {
  readonly ref: string
  readonly object: { readonly sha: string, readonly type: string }
}

interface ReleaseAssetView {
  readonly name: string
  readonly size: number
  readonly state: string
  readonly digest?: string
}

interface ReleaseView {
  readonly tagName: string
  readonly isDraft: boolean
  readonly isPrerelease: boolean
  readonly targetCommitish: string
  readonly assets: readonly ReleaseAssetView[]
  readonly url: string
}

function fail(message: string): never {
  throw new DesktopGithubReleaseRuleError(message)
}

function runGh(args: readonly string[]): GhResult {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) {
    throw new GhUnavailableError(`gh ${args[0]} could not run: ${result.error.message}`)
  }
  return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function stderrTail(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(line => line !== '')
  const tail = lines.slice(-3).join(' | ')
  return tail.length > 400 ? `${tail.slice(-400)}…` : tail
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Parse the release command line into assets and publishing flags.
 * @param argv - Command line after the script name.
 * @returns Assets in argument order plus the notes file, title, repository, latest flag, and dry-run flag.
 */
export function parseDesktopGithubReleaseArgs(argv: readonly string[]): {
  readonly assets: readonly string[]
  readonly notesFile: string
  readonly title: string | null
  readonly repository: string
  readonly latest: boolean
  readonly dryRun: boolean
} {
  const assets: string[] = []
  let notesFile: string | null = null
  let title: string | null = null
  let repository = DESKTOP_GITHUB_REPOSITORY
  let latest = false
  let dryRun = false
  const flagsWithValue = new Map<string, (value: string) => void>([
    ['--notes-file', value => { notesFile = value }],
    ['--title', value => { title = value }],
    ['--repository', value => { repository = value }],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--latest') {
      latest = true
      continue
    }
    const accept = flagsWithValue.get(arg)
    if (accept !== undefined) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value\n\n${USAGE}`)
      accept(value)
      index += 1
      continue
    }
    if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`)
    assets.push(arg)
  }
  if (assets.length === 0) fail(`no installer given\n\n${USAGE}`)
  if (notesFile === null) fail(`--notes-file is required; a public release publishes without notes otherwise\n\n${USAGE}`)
  return { assets, notesFile, title, repository, latest, dryRun }
}

/**
 * Validate the local artifacts and the completion record into a publish plan.
 * @param assets - Installer first, then any extra assets, in upload order.
 * @param notesFile - Markdown file with the release notes.
 * @param title - Release title, or null for the "Cadre Heihei <version>" default.
 * @param repository - GitHub repository that receives the release.
 * @param prerelease - Whether the release is marked prerelease; the --latest flag passes false.
 * @returns The validated plan naming one commit, one version, and every uploaded file.
 */
export function resolveDesktopGithubReleasePlan(
  assets: readonly string[],
  notesFile: string,
  title: string | null,
  repository: string,
  prerelease = true,
): DesktopGithubReleasePlan {
  if (!/^[^\s/]+\/[^\s/]+$/.test(repository)) fail(`repository ${repository} is not owner/name`)
  if (!existsSync(notesFile) || statSync(notesFile).size === 0) {
    fail(`desktop release: notes file ${notesFile} is missing or empty; write the release notes before publishing`)
  }
  for (const asset of assets) {
    if (!existsSync(asset)) fail(`desktop release: asset ${asset} does not exist`)
    if (statSync(asset).size === 0) fail(`desktop release: asset ${asset} is empty`)
  }
  const installer = resolve(assets[0] ?? '')
  const installerName = basename(installer)
  const target = TARGET_SEGMENT_PATTERN.exec(installerName)?.[1]
  if (target === undefined) {
    fail(`desktop release: cannot read the desktop target from ${installerName}; pass an installer named like cadre-heihei-<version>-<target>-unsigned.exe`)
  }
  const recordPath = join(dirname(installer), `${target}-release.json`)
  const record = readDesktopCompletionRecord(recordPath)
  if (record.target !== target) {
    fail(`desktop release: completion record ${recordPath} names target ${record.target || '(missing)'}, not the ${target} installer beside it; rebuild so one build produces both`)
  }
  if (record.version === '') {
    fail(`desktop release: completion record ${recordPath} names no version; rebuild so the record names the packaged version`)
  }
  const namedVersion = VERSION_SEGMENT_PATTERN.exec(installerName)?.[1]
  if (namedVersion === undefined) {
    fail(`desktop release: cannot read the version from ${installerName}; rename the installer to the packaged name`)
  }
  if (namedVersion !== record.version) {
    fail(`desktop release: installer ${installerName} names version ${namedVersion} but the completion record names ${record.version}; rebuild so one build produces both`)
  }
  if (!COMMIT_PATTERN.test(record.commit)) {
    fail(`desktop release: completion record ${recordPath} names commit ${record.commit || '(missing)'}, which is not a full commit id; rebuild so the record names the packaged commit`)
  }
  if (record.dirty) {
    fail(`desktop release: the build was packaged from ${record.commit} with uncommitted changes; the tag v${record.version} would not name the tree users received — rebuild from a clean checkout before publishing`)
  }
  const planned = [...assets.map(path => resolve(path))]
  const blockmap = `${installer}.blockmap`
  if (existsSync(blockmap) && !planned.includes(blockmap)) planned.push(blockmap)
  const planAssets = planned.map(path => ({ path, name: basename(path), size: statSync(path).size }))
  return {
    repository,
    target,
    version: record.version,
    commit: record.commit,
    tag: `v${record.version}`,
    title: title ?? `Cadre Heihei ${record.version}`,
    notesFile: resolve(notesFile),
    prerelease,
    assets: planAssets,
  }
}

function readDesktopCompletionRecord(recordPath: string): DesktopCompletionRecord {
  if (!existsSync(recordPath)) {
    fail(`desktop release: no completion record at ${recordPath}; package with the current build scripts so <target>-release.json lands beside the installer`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'))
  }
  catch (error) {
    fail(`desktop release: completion record at ${recordPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`desktop release: completion record at ${recordPath} must be an object`)
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    fail(`desktop release: completion record at ${recordPath} has schemaVersion ${String(record.schemaVersion)}; package again with the current build scripts`)
  }
  return {
    schemaVersion: 1,
    target: typeof record.target === 'string' ? record.target : '',
    version: typeof record.version === 'string' ? record.version : '',
    commit: typeof record.commit === 'string' ? record.commit : '',
    dirty: record.dirty === true,
  }
}

function ghApiAbsent(result: GhResult): boolean {
  return /404|not found/i.test(result.stderr)
}

function parseGhJson<T>(result: GhResult, label: string): T {
  try {
    return JSON.parse(result.stdout) as T
  }
  catch (error) {
    return fail(`desktop release: cannot parse the ${label} response (gh exit ${result.status}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Prove the three-point identity remotely before any write happens.
 * @param plan - Validated plan naming the packaged commit.
 * @param run - gh runner seam.
 * @returns Whether the release already exists with zero assets, which makes this run a resume.
 */
export function verifyDesktopGithubReleaseIdentity(plan: DesktopGithubReleasePlan, run: GhRunner): { readonly releaseExisted: boolean } {
  const short = plan.commit.slice(0, 12)
  const commitCheck = run(['api', `repos/${plan.repository}/commits/${plan.commit}`])
  if (commitCheck.status !== 0) {
    if (ghApiAbsent(commitCheck)) {
      fail(`desktop release: packaged commit ${short} is not on ${plan.repository}; push the release commit before publishing`)
    }
    fail(`desktop release: cannot verify commit ${short} on ${plan.repository} (gh exit ${commitCheck.status}): ${stderrTail(commitCheck.stderr)}`)
  }

  const tagCheck = run(['api', `repos/${plan.repository}/git/ref/tags/${plan.tag}`])
  if (tagCheck.status === 0) {
    const ref = parseGhJson<TagRef>(tagCheck, `tag ${plan.tag} ref`)
    if (ref.object.type !== 'commit') {
      fail(`desktop release: tag ${plan.tag} is an annotated tag object; the release flow only accepts a lightweight tag naming ${short} — inspect and fix the tag manually`)
    }
    if (ref.object.sha !== plan.commit) {
      fail(`desktop release: tag ${plan.tag} names ${ref.object.sha}, not the packaged commit ${plan.commit}; the tag, the release target and the packaged commit must be one commit — reconcile the tag before publishing`)
    }
  }
  else if (!ghApiAbsent(tagCheck)) {
    fail(`desktop release: cannot verify tag ${plan.tag} (gh exit ${tagCheck.status}): ${stderrTail(tagCheck.stderr)}`)
  }

  const view = viewRelease(plan, run)
  if (view === undefined) return { releaseExisted: false }
  if (view.isDraft) {
    fail(`desktop release: release ${plan.tag} is a draft; another operator may be preparing it — one person publishes a release, so verify and reconcile the draft manually instead of uploading into it`)
  }
  if (view.isPrerelease !== plan.prerelease) {
    const remote = view.isPrerelease ? 'is marked prerelease' : 'is not marked prerelease'
    const planned = plan.prerelease ? 'a prerelease' : 'a full release (--latest)'
    fail(`desktop release: release ${plan.tag} ${remote}, but this run publishes ${planned}; one person publishes a release — reconcile the existing release manually instead of uploading into it`)
  }
  if (view.targetCommitish !== plan.commit) {
    fail(`desktop release: release ${plan.tag} targets ${view.targetCommitish}, not the packaged commit ${plan.commit}; the tag, the release target and the packaged commit must be one commit (v1.5.3 shipped this mismatch) — delete the release and publish again with this script`)
  }
  if (view.assets.length > 0) {
    const names = view.assets.map(asset => asset.name).join(', ')
    fail(`desktop release: release ${plan.tag} already carries ${view.assets.length} asset(s): ${names}; one person publishes a release — another operator may have published it; verify the release and reconcile manually instead of uploading again`)
  }
  return { releaseExisted: true }
}

function viewRelease(plan: DesktopGithubReleasePlan, run: GhRunner): ReleaseView | undefined {
  const fields = 'tagName,isDraft,isPrerelease,targetCommitish,assets,url'
  const result = run(['release', 'view', plan.tag, '--repo', plan.repository, '--json', fields])
  if (result.status !== 0) {
    if (/release .*not found/i.test(result.stderr)) return undefined
    fail(`desktop release: cannot read release ${plan.tag} (gh exit ${result.status}): ${stderrTail(result.stderr)}`)
  }
  return parseGhJson<ReleaseView>(result, `release ${plan.tag} view`)
}

/**
 * Create the release when absent and upload every planned asset.
 * @param plan - Validated plan naming one commit.
 * @param releaseExisted - True when the preflight found an empty release targeting the commit.
 * @param run - gh runner seam.
 */
export function publishDesktopGithubRelease(plan: DesktopGithubReleasePlan, releaseExisted: boolean, run: GhRunner): void {
  if (!releaseExisted) {
    const created = run([
      'release', 'create', plan.tag, '--repo', plan.repository, '--target', plan.commit,
      ...(plan.prerelease ? ['--prerelease'] : []),
      '--title', plan.title, '--notes-file', plan.notesFile,
    ])
    if (created.status !== 0) {
      fail(`desktop release: gh release create ${plan.tag} failed (exit ${created.status}): ${stderrTail(created.stderr)}; another operator may have created it meanwhile — view the release before doing anything else`)
    }
  }
  const uploaded = run(['release', 'upload', plan.tag, '--repo', plan.repository, ...plan.assets.map(asset => asset.path)])
  if (uploaded.status !== 0) {
    fail(`desktop release: gh release upload ${plan.tag} failed (exit ${uploaded.status}): ${stderrTail(uploaded.stderr)}; the release may hold partial assets — view it and reconcile before uploading again`)
  }
}

/**
 * Read the published release back and prove the identities and assets survived the upload.
 * @param plan - Validated plan naming one commit.
 * @param run - gh runner seam.
 * @returns The release URL.
 */
export function verifyPublishedDesktopGithubRelease(plan: DesktopGithubReleasePlan, run: GhRunner): { readonly url: string } {
  const view = viewRelease(plan, run)
  if (view === undefined) fail(`desktop release: verification failed: release ${plan.tag} disappeared after publishing`)
  if (view.tagName !== plan.tag) {
    fail(`desktop release: verification failed: release names tag ${view.tagName}, expected ${plan.tag}`)
  }
  if (view.targetCommitish !== plan.commit) {
    fail(`desktop release: verification failed: release ${plan.tag} targets ${view.targetCommitish}, expected ${plan.commit}`)
  }
  if (view.isPrerelease !== plan.prerelease) {
    const remote = view.isPrerelease ? 'is marked prerelease' : 'is not marked prerelease'
    fail(`desktop release: verification failed: release ${plan.tag} ${remote}, expected ${plan.prerelease ? 'a prerelease' : 'a full release (--latest)'}`)
  }
  for (const asset of plan.assets) {
    const remote = view.assets.find(candidate => candidate.name === asset.name)
    if (remote === undefined) {
      fail(`desktop release: verification failed: asset ${asset.name} is not on the release`)
    }
    if (remote.state !== 'uploaded') {
      fail(`desktop release: verification failed: asset ${asset.name} state ${remote.state}, expected uploaded`)
    }
    if (typeof remote.digest === 'string' && remote.digest.startsWith('sha256:')) {
      const localDigest = `sha256:${sha256File(asset.path)}`
      if (remote.digest.toLowerCase() !== localDigest) {
        fail(`desktop release: verification failed: asset ${asset.name} digest ${remote.digest} does not match the local file ${localDigest}`)
      }
    }
    else if (remote.size !== asset.size) {
      fail(`desktop release: verification failed: asset ${asset.name} is ${remote.size} B remotely, expected ${asset.size} B`)
    }
  }
  return { url: view.url }
}

/**
 * Run the whole publish: local validation, three-point remote proof, create, upload, read-back.
 * @param argv - Command line after the script name.
 * @param options - gh and log seams for tests.
 * @returns The outcome with the plan and, on success, nothing else to do.
 */
export function desktopGithubRelease(argv: readonly string[], options: DesktopGithubReleaseOptions = {}): DesktopGithubReleaseResult {
  const run = options.run ?? runGh
  const log = options.log ?? ((message: string) => console.log(message))
  try {
    const args = parseDesktopGithubReleaseArgs(argv)
    const plan = resolveDesktopGithubReleasePlan(args.assets, args.notesFile, args.title, args.repository, !args.latest)
    const assetNames = plan.assets.map(asset => `${asset.name} (${asset.size} B)`).join(', ')
    log(`desktop release: v${plan.version} from ${plan.repository} @ ${plan.commit.slice(0, 12)} (${plan.target}${plan.prerelease ? ', prerelease' : ', latest'})`)
    log(`desktop release: assets: ${assetNames}`)
    const { releaseExisted } = verifyDesktopGithubReleaseIdentity(plan, run)
    log(`desktop release: three-point identity verified${releaseExisted ? '; resuming an empty release' : ''}`)
    if (args.dryRun) {
      return { ok: true, message: `dry run: checks passed; nothing was written${releaseExisted ? ' (the empty release would be resumed)' : ''}`, plan }
    }
    publishDesktopGithubRelease(plan, releaseExisted, run)
    const { url } = verifyPublishedDesktopGithubRelease(plan, run)
    log(`desktop release: tag ${plan.tag} = release target = packaged commit ${plan.commit}`)
    log(`desktop release: published ${plan.tag} at ${url}`)
    return { ok: true, message: `published ${plan.tag} at ${url}`, plan }
  }
  catch (error) {
    if (error instanceof GhUnavailableError) {
      return { ok: false, message: `desktop release: ${error.message}; install the GitHub CLI and authenticate with gh auth login` }
    }
    if (error instanceof DesktopGithubReleaseRuleError) return { ok: false, message: error.message }
    throw error
  }
}

function main(): number {
  const result = desktopGithubRelease(process.argv.slice(2))
  if (!result.ok) {
    console.error(result.message)
    return 1
  }
  if (!result.message.startsWith('published')) console.log(result.message)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
