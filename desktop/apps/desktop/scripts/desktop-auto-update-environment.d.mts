/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** GitHub repository that hosts every Desktop release artifact, including update metadata. */
export const DESKTOP_GITHUB_REPOSITORY: 'KyuuKyuuStone/cadre-heihei'

/** Environment variable replacing the GitHub repository that hosts Desktop releases. */
export const DESKTOP_GITHUB_REPOSITORY_ENV: 'DSH_DESKTOP_UPDATE_GITHUB_REPOSITORY'

/** Supported Desktop update deployment. */
export type DesktopAutoUpdateEnvironment = 'test' | 'production'

/** Directory name of one supported Desktop release target. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** GitHub source one packaged application reads its updates from. */
export interface DesktopGithubUpdateSource {
  readonly environment: DesktopAutoUpdateEnvironment
  readonly provider: 'github'
  readonly channel: 'nightly' | 'latest'
  readonly target: DesktopAutoUpdateTarget
  readonly owner: string
  readonly repo: string
  readonly releaseType: 'prerelease' | 'release'
}

/** Generic feed the installed-update qualification deployment reads its updates from. */
export interface DesktopGenericUpdateSource {
  readonly environment: DesktopAutoUpdateEnvironment
  readonly provider: 'generic'
  readonly channel: 'nightly' | 'latest'
  readonly target: DesktopAutoUpdateTarget
  readonly origin: string
  readonly publicUrl: string
  readonly keyPrefix: string
  readonly binaryKeyPrefix: string
}

/** Update source sealed into one packaged application. */
export type DesktopUpdateSource = DesktopGithubUpdateSource | DesktopGenericUpdateSource

/** Public updater URL and private COS destination for one upload target. */
export interface DesktopUploadConfig extends DesktopGenericUpdateSource {
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param env - Packaging or upload environment.
 * @returns Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopAutoUpdateEnvironment

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateTarget

/**
 * Return the local completion record filename for one packaged target.
 * @param target - Supported release target.
 * @returns Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @returns Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(
  version: string,
  platform: NodeJS.Platform,
  channel?: 'nightly' | 'latest',
): string

/**
 * Resolve the update source sealed into one packaged application.
 * @param env - Packaging environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns GitHub Releases, or the generic test feed when its loopback origin is configured.
 * @throws When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopUpdateSource

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param env - Upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved upload configuration.
 * @throws When the selected deployment lacks a bucket or a valid HTTPS origin.
 */
export function resolveDesktopUploadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopUploadConfig

/**
 * Resolve the GitHub repository that receives Desktop releases.
 * @param env - Packaging or upload environment.
 * @returns Repository owner and name.
 * @throws When the configured repository is not an owner/name pair.
 */
export function resolveDesktopGithubRepository(
  env: NodeJS.ProcessEnv,
): { readonly owner: string, readonly repo: string }

/**
 * Resolve the packaged update channel, defaulting omitted local settings to nightly.
 * @param env Packaging settings.
 * @returns Validated channel.
 */
export function resolveDesktopUpdateChannel(env: NodeJS.ProcessEnv): 'nightly' | 'latest'
