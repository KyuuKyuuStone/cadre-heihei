/**
 * Carry the commit a build came from into its artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * The packaging entry reads the checkout once and passes the result to every
 * child process, which run against a build tree rather than a checkout.
 *
 * A source tree without Git history still has to package: the read falls back
 * to CADRE_SOURCE_COMMIT and then to `unknown` with a warning, while a release
 * build refuses to leave the commit unknown. A real commit is also handed to
 * the client build, which embeds one in browser artifacts and cannot run
 * without Git or an explicit value.
 */

import { execFileSync } from 'node:child_process'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/** Environment variable that names the commit when the source tree has no Git history. */
export const CADRE_SOURCE_COMMIT_ENV = 'CADRE_SOURCE_COMMIT'

/** Commit recorded when neither Git nor CADRE_SOURCE_COMMIT names one. */
export const UNKNOWN_DESKTOP_BUILD_COMMIT = 'unknown'

/** Environment variable that carries the commit the client build embeds in browser artifacts (see desktop/scripts/client-build-environment.ts). */
export const CLIENT_BUILD_COMMIT_ENV = 'DSH_CLIENT_COMMIT_HASH'

/** Git failures that mean no commit is readable from the checkout: no repository, or one without commits. */
const NO_GIT_SOURCE = /not a git repository|ambiguous argument|unknown revision/iu

const isMissingGitSource = error =>
  typeof error?.stderr === 'string' && NO_GIT_SOURCE.test(error.stderr)

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 *
 * Outside a Git repository (or in one without commits) the commit comes from
 * CADRE_SOURCE_COMMIT, else it degrades to `unknown` with a warning; `dirty`
 * is false because a tree without Git history has no dirty state to read.
 * Other git failures still throw: a broken repository is a real stop.
 * @param {string} repositoryRoot - Directory to inspect.
 * @param {{ requireRealCommit?: boolean }} [options] - Release builds set `requireRealCommit` to fail instead of packaging `unknown`.
 * @returns {{ commit: string, dirty: boolean }} The commit being packaged (possibly `unknown`) and whether its tree was modified.
 */
export function readDesktopBuildCommit(repositoryRoot, options = {}) {
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  try {
    return {
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
    }
  } catch (error) {
    if (!isMissingGitSource(error)) throw error
  }
  const override = process.env[CADRE_SOURCE_COMMIT_ENV]?.trim()
  if (override !== undefined && override !== '') {
    if (!/^[0-9a-f]{40}$/u.test(override)) {
      throw new Error(`desktop build commit: ${CADRE_SOURCE_COMMIT_ENV} must be a commit hash`)
    }
    return { commit: override, dirty: false }
  }
  if (options.requireRealCommit === true) {
    throw new Error(`desktop build commit: a release build needs a real source commit; package inside the Git repository or set ${CADRE_SOURCE_COMMIT_ENV} to the commit being packaged`)
  }
  process.stderr.write(`desktop build commit: no Git history at ${repositoryRoot}; recording ${UNKNOWN_DESKTOP_BUILD_COMMIT} as the build commit; set ${CADRE_SOURCE_COMMIT_ENV} to a commit hash to keep provenance; the client build step also requires a real commit\n`)
  return { commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty: false }
}

/**
 * Resolve the commit a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean } | undefined} The packaged commit, or undefined outside a packaging run.
 *   A commit of `unknown` passes through as the no-Git-history fallback.
 */
export function resolveDesktopBuildCommit(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (commit !== UNKNOWN_DESKTOP_BUILD_COMMIT && !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  }
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe the packaged commit as the environment variables child processes read.
 * A real commit is also handed to the client build, which embeds one in browser
 * artifacts and cannot resolve it without Git; an explicit value in `inherited`
 * wins because its caller chose it for that build.
 * @param {{ commit: string, dirty: boolean }} packaged - Commit and tree state to pass down.
 * @param {NodeJS.ProcessEnv} [inherited] - Environment the packaging run already resolved.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged, inherited = {}) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',
    ...(packaged.commit === UNKNOWN_DESKTOP_BUILD_COMMIT || inherited[CLIENT_BUILD_COMMIT_ENV] !== undefined
      ? {} : { [CLIENT_BUILD_COMMIT_ENV]: packaged.commit }),
  }
}
