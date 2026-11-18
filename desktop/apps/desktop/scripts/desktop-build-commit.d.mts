/** Commit a build came from — `unknown` when the source tree had no Git history — and whether its checkout carried uncommitted changes. */
export interface DesktopBuildCommit {
  readonly commit: string
  readonly dirty: boolean
}

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV: 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV: 'DSH_DESKTOP_BUILD_DIRTY'

/** Environment variable that names the commit when the source tree has no Git history. */
export const CADRE_SOURCE_COMMIT_ENV: 'CADRE_SOURCE_COMMIT'

/** Commit recorded when neither Git nor CADRE_SOURCE_COMMIT names one. */
export const UNKNOWN_DESKTOP_BUILD_COMMIT: 'unknown'

/** Environment variable that carries the commit the client build embeds in browser artifacts. */
export const CLIENT_BUILD_COMMIT_ENV: 'DSH_CLIENT_COMMIT_HASH'

/** Options for reading the commit a build packages. */
export interface DesktopBuildCommitReadOptions {
  /** Fail instead of packaging `unknown`; release builds set this. */
  readonly requireRealCommit?: boolean
}

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * Outside a Git repository (or in one without commits) the commit comes from
 * `CADRE_SOURCE_COMMIT`, else it degrades to `unknown` with a warning; `dirty`
 * is false in that case. Other git failures still throw.
 * @param repositoryRoot - Directory to inspect.
 * @param options - Release builds set `requireRealCommit` to fail instead of packaging `unknown`.
 * @returns The commit being packaged (possibly `unknown`) and whether its tree was modified.
 */
export function readDesktopBuildCommit(repositoryRoot: string, options?: DesktopBuildCommitReadOptions): DesktopBuildCommit

/**
 * Resolve the commit a parent packaging process recorded.
 * @param env - Packaging environment.
 * @returns The packaged commit, or undefined outside a packaging run. `unknown` passes through as the no-Git-history fallback.
 */
export function resolveDesktopBuildCommit(env: NodeJS.ProcessEnv): DesktopBuildCommit | undefined

/**
 * Describe the packaged commit as the environment variables child processes read.
 * A real commit is also handed to the client build; an explicit value in `inherited` wins.
 * @param packaged - Commit and tree state to pass down.
 * @param inherited - Environment the packaging run already resolved.
 * @returns Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged: DesktopBuildCommit, inherited?: NodeJS.ProcessEnv): Record<string, string>
