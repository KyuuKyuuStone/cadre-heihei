/**
 * Resolve the scratch-tree parent: the `DSH_DESKTOP_RUNTIME_BUILD_ROOT` override or the fixed
 * per-account `~/.dsh-desktop-build/runtime` directory outside the repository and the system temporary directory.
 * @param environment Packaging configuration; an absent override selects the per-account default.
 * @returns Absolute directory; rejects overrides that are relative or contain NUL, CR or LF.
 */
export function resolveDesktopRuntimeBuildRoot(environment: NodeJS.ProcessEnv): string

/**
 * Create a fresh per-run scratch tree inside the resolved root; callers delete it when their run ends.
 * @param environment Packaging configuration passed to the resolver.
 * @returns Absolute path of the created `dsh-desktop-runtime-`-prefixed directory.
 */
export function createDesktopRuntimeBuildRoot(environment: NodeJS.ProcessEnv): string
