/** Resolve the Desktop update source and the legacy COS upload destination. */

import { valid } from 'semver'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** GitHub repository that hosts every Desktop release artifact, including update metadata. */
export const DESKTOP_GITHUB_REPOSITORY = 'KyuuKyuuStone/cadre-heihei'

/** Environment variable replacing the GitHub repository that hosts Desktop releases. */
export const DESKTOP_GITHUB_REPOSITORY_ENV = 'DSH_DESKTOP_UPDATE_GITHUB_REPOSITORY'

/**
 * Resolve the channel embedded in the installer; omitted local settings retain nightly.
 * @param {NodeJS.ProcessEnv} env Packaging or upload settings.
 * @returns {'nightly' | 'latest'} Validated channel.
 */
export function resolveDesktopUpdateChannel(env) {
  const channel = env.DSH_DESKTOP_UPDATE_CHANNEL || 'nightly'
  if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop auto-update: invalid update channel')
  return channel
}

const UPDATE_ENVIRONMENTS = {
  test: {
    originEnvName: 'DOWNLOAD_TEST_ORIGIN',
    bucketEnvName: 'DOWNLOAD_TEST_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
  },
  production: {
    originEnvName: 'DOWNLOAD_PROD_ORIGIN',
    bucketEnvName: 'DOWNLOAD_PROD_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test" or "production"`)
  }
  return value
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {'nightly' | 'latest'} channel - Selected channel; omitted means nightly.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform, channel = 'nightly') {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  resolveDesktopUpdateChannel({ DSH_DESKTOP_UPDATE_CHANNEL: channel })
  return `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Read one required release setting without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} name - Environment variable to read.
 * @returns {string} Trimmed setting.
 */
function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Normalize an HTTPS origin and reject paths or credentials.
 * @param {string} value - Candidate origin.
 * @param {string} name - Environment variable used in diagnostics.
 * @returns {string} Normalized HTTPS origin without a trailing slash.
 */
function httpsOrigin(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin`)
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin without a path, credentials, query, or fragment`)
  }
  return parsed.origin
}

/**
 * Resolve the GitHub repository that receives Desktop releases.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {{ owner: string, repo: string }} Repository owner and name.
 * @throws {Error} When the configured repository is not an owner/name pair.
 */
export function resolveDesktopGithubRepository(env) {
  const value = env[DESKTOP_GITHUB_REPOSITORY_ENV]?.trim() || DESKTOP_GITHUB_REPOSITORY
  const match = /^([^\s/]+)\/([^\s/]+)$/u.exec(value)
  if (match === null) throw new Error(`desktop auto-update: ${DESKTOP_GITHUB_REPOSITORY_ENV} must be an owner/name pair`)
  return { owner: match[1], repo: match[2] }
}

/**
 * Resolve the update source sealed into one packaged application.
 *
 * Every Desktop release reads its updates from the project's own GitHub Releases, which needs no
 * signing inputs and therefore also covers artifacts built without a certificate. Only an
 * explicit test deployment with its loopback origin keeps the generic feed used by installed-update
 * qualification.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', provider: 'github', channel: 'nightly' | 'latest', target: 'mac-arm64' | 'mac-x64' | 'win-x64', owner: string, repo: string, releaseType: 'prerelease' | 'release' }
 *   | { environment: 'test' | 'production', provider: 'generic', channel: 'nightly' | 'latest', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string }}
 *   Resolved update source.
 * @throws {Error} When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch) {
  const channel = resolveDesktopUpdateChannel(env)
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  if (environment !== 'test' || env.DOWNLOAD_TEST_ORIGIN === undefined) {
    const { owner, repo } = resolveDesktopGithubRepository(env)
    return { environment, provider: 'github', channel, target, owner, repo, releaseType: channel === 'latest' ? 'release' : 'prerelease' }
  }
  const origin = httpsOrigin(requiredEnvironmentValue(env, 'DOWNLOAD_TEST_ORIGIN'), 'DOWNLOAD_TEST_ORIGIN')
  const releaseId = requiredEnvironmentValue(env, 'DOWNLOAD_TEST_RELEASE_ID')
  if (!/^[a-f0-9]{32}$/u.test(releaseId)) {
    throw new Error('desktop auto-update: DOWNLOAD_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
  }
  const keyPrefix = `dsh-desk/${releaseId}/feeds/${target}`
  return {
    environment,
    provider: 'generic',
    channel,
    target,
    origin,
    keyPrefix,
    binaryKeyPrefix: `dsh-desk/${releaseId}/bin/${target}${channel === 'latest' ? '/latest' : ''}`,
    publicUrl: `${origin}/${keyPrefix}/`,
  }
}

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', provider: 'generic', channel: 'nightly' | 'latest', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string, bucket: string, secretIdEnvName: string, secretKeyEnvName: string }} Resolved upload configuration.
 * @throws {Error} When the selected deployment lacks a bucket or a valid HTTPS origin.
 */
export function resolveDesktopUploadConfig(env, platform, arch) {
  const channel = resolveDesktopUpdateChannel(env)
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[environment]
  const origin = httpsOrigin(requiredEnvironmentValue(env, deployment.originEnvName), deployment.originEnvName)
  let releasePrefix = 'dsh-desk'
  if (environment === 'test') {
    const releaseId = requiredEnvironmentValue(env, 'DOWNLOAD_TEST_RELEASE_ID')
    if (!/^[a-f0-9]{32}$/u.test(releaseId)) {
      throw new Error('desktop auto-update: DOWNLOAD_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
    }
    releasePrefix += `/${releaseId}`
  }
  const keyPrefix = `${releasePrefix}/feeds/${target}`
  return {
    environment,
    provider: 'generic',
    channel,
    target,
    origin,
    keyPrefix,
    binaryKeyPrefix: `${releasePrefix}/bin/${target}${channel === 'latest' ? '/latest' : ''}`,
    publicUrl: `${origin}/${keyPrefix}/`,
    bucket: requiredEnvironmentValue(env, deployment.bucketEnvName),
    secretIdEnvName: deployment.secretIdEnvName,
    secretKeyEnvName: deployment.secretKeyEnvName,
  }
}
