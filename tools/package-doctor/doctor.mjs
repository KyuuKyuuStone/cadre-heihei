#!/usr/bin/env node
/**
 * package-doctor: preflight a machine for packaging the Cadre Heihei desktop
 * product from source. Read-only: it never modifies the repository, caches, or
 * local dotenv files, and never echoes dotenv values or proxy credentials
 * (key names and masked endpoints only).
 *
 * The repository's own configuration authority is `pnpm --dir apps/desktop run
 * check:package` (package-target.ts --check). Doctor runs it first and
 * classifies its output; the remaining checks cover new-machine pitfalls that
 * command does not inspect (engines, disk, mirror/cache coupling, proxy
 * loopback bypass, path hygiene, git dirty state, source commit fallback).
 *
 * Output: one line per check, PASS/WARN/FAIL, each failure with a directly
 * pastable fix command. Exit codes: 0 all PASS, 1 at least one WARN (no FAIL),
 * 2 at least one FAIL, 64 invalid invocation (bad arguments or the selected
 * directory is not a desktop workspace).
 *
 * Usage: node doctor.mjs [--repo <desktop-workspace-root>]
 * The repository defaults to the current working directory.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { parseEnv } from 'node:util'

// Spawning the `pnpm` shim with shell:true is deliberate (pnpm is a .cmd on
// Windows and Node refuses shell-less .cmd spawns); silence the cosmetic
// DEP0190 warning that this would otherwise print once per spawn.
process.noDeprecation = true

// ---------------------------------------------------------------------------
// Arguments and layout. The repository defaults to the current working
// directory; --repo overrides it. Either way the target must be a desktop
// workspace root (package.json plus apps/desktop/package.json).
// ---------------------------------------------------------------------------
// Only --repo <path>, --help and -h are accepted; anything else is a usage
// error (exit 64), including a --repo value that starts with "-".
let repoArg
let argError
let wantsHelp = false
for (let index = 2; index < process.argv.length && argError === undefined; index += 1) {
  const arg = process.argv[index]
  if (arg === '--help' || arg === '-h') wantsHelp = true
  else if (arg === '--repo') {
    const value = process.argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('-')) argError = '--repo needs a path argument.'
    else if (repoArg !== undefined) argError = '--repo was given more than once.'
    else { repoArg = value; index += 1 }
  } else argError = `unknown argument "${arg}".`
}
const repo = resolve(repoArg ?? process.cwd())
const appDesktop = join(repo, 'apps', 'desktop')

const results = []
const record = (id, status, detail, fix) => results.push({ id, status, detail, fix })

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: options.timeout ?? 60_000, cwd: options.cwd,
    shell: process.platform === 'win32', windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ok: !result.error && result.status === 0,
    error: result.error,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

const directorySize = path => {
  let total = 0
  if (!existsSync(path)) return undefined
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? directorySize(child) ?? 0 : statSync(child).size
  }
  return total
}

// ---------------------------------------------------------------------------
// 1+2. Local dotenv presence, key acceptance, and policy self-consistency.
//      Key classes and policy rules mirror desktop-package-environment.mjs:17-21
//      and desktop-policy-environment.mjs:4-39; values are never printed.
// ---------------------------------------------------------------------------
const SHARED_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|MANDATORY_UPDATE_(?:CONFIG|(?:TEST|PROD)_ORIGIN))|DOWNLOAD_TEST_RELEASE_ID|DOWNLOAD_(?:TEST|PROD)_(?:ORIGIN|COS_BUCKET|COS_SECRET_ID|COS_SECRET_KEY))$/u
const WINDOWS_SETTING = /^DSH_DESKTOP_WINDOWS_(?:CER_FILE|SIGNTOOL|KEY_CONTAINER|TOKEN_PIN|SIGNATURE_CACHE_DIR|SIGNATURE_CACHE_CONCURRENCY)$/u
const MACOS_SETTING = /^(?:DSH_DESKTOP_MACOS_(?:SIGNING_IDENTITY|TEAM_ID|SIGNATURE_CACHE_DIR|PACK_CONCURRENCY|DOWNLOAD_PROXY|NOTARIZATION_PROXY)|APPLE_(?:API_KEY|API_KEY_ID|API_ISSUER|ID|APP_SPECIFIC_PASSWORD|TEAM_ID|KEYCHAIN|KEYCHAIN_PROFILE)|CSC_(?:LINK|KEY_PASSWORD))$/u
// Preset files accept the narrower allowlist of desktop-package-environment.mjs:58-60.
const PRESET_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|MANDATORY_UPDATE_(?:CONFIG|(?:TEST|PROD)_ORIGIN))|DOWNLOAD_TEST_(?:ORIGIN|RELEASE_ID))$/u
const PUBLIC_PLATFORM_SETTING = process.platform === 'win32'
  ? /^DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_(?:DIR|CONCURRENCY)$/u
  : /^DSH_DESKTOP_MACOS_(?:SIGNATURE_CACHE_DIR|PACK_CONCURRENCY|DOWNLOAD_PROXY|NOTARIZATION_PROXY)$/u

const originProblem = value => {
  let url
  try { url = new URL(value) } catch { return 'not an absolute URL' }
  if (url.protocol !== 'https:') return 'protocol is not https'
  if (url.username || url.password) return 'carries credentials'
  if (url.pathname !== '/') return 'carries a path'
  if (url.search) return 'carries a query'
  if (url.hash) return 'carries a fragment'
  return undefined
}

const configProblem = (environment, { requirePolicy }) => {
  const problems = []
  const deployment = (environment.DSH_DESKTOP_AUTO_UPDATE_ENV ?? 'test').trim() || 'test'
  if (deployment !== 'test' && deployment !== 'production') {
    problems.push(`DSH_DESKTOP_AUTO_UPDATE_ENV must be test or production (got the key with a foreign value)`)
    return problems
  }
  if (environment.DSH_DESKTOP_APP_ID?.trim() === undefined || environment.DSH_DESKTOP_APP_ID?.trim() === '') {
    problems.push('DSH_DESKTOP_APP_ID is missing or blank')
  }
  if (!requirePolicy) return problems
  const originName = deployment === 'test' ? 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN' : 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN'
  const selected = environment[originName]
  if (selected === undefined || selected.trim() === '') problems.push(`${originName} is missing or blank`)
  else {
    const problem = originProblem(selected.trim())
    if (problem) problems.push(`${originName} ${problem}`)
  }
  let config = {}
  if (environment.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG !== undefined) {
    try { config = JSON.parse(environment.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG) }
    catch { problems.push('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG is not valid JSON'); return problems }
    if (typeof config !== 'object' || config === null || Array.isArray(config) || 'origin' in config || 'authentication' in config) {
      problems.push('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG must be an object without origin or authentication')
      config = {}
    }
  }
  const pages = config.allowedPageOrigins ?? [selected]
  if (!Array.isArray(pages) || pages.length === 0) problems.push('allowedPageOrigins must be a nonempty array')
  else for (const page of pages) { const problem = originProblem(String(page)); if (problem) problems.push(`allowedPageOrigins entry ${problem}`) }
  const authOrigins = config.allowedAuthOrigins
  if (deployment === 'test' && (!Array.isArray(authOrigins) || authOrigins.length === 0)) {
    problems.push('the test deployment requires nonempty allowedAuthOrigins')
  } else if (deployment === 'test') {
    for (const auth of authOrigins) { const problem = originProblem(String(auth)); if (problem) problems.push(`allowedAuthOrigins entry ${problem}`) }
  }
  if (deployment === 'production' && authOrigins !== undefined) {
    problems.push('the production deployment must not configure allowedAuthOrigins')
  }
  return problems
}

const checkDotenv = () => {
  const preset = process.env.DSH_PACKAGING_PRESET
  const localName = process.platform === 'darwin' ? '.env.macos' : '.env.windows'
  const templateName = `${localName}.example`
  let path
  let accepts
  if (preset !== undefined) {
    if (preset !== 'test' && preset !== 'production') {
      record('dotenv', 'FAIL', `DSH_PACKAGING_PRESET must be test or production (got "${preset}")`, `Set DSH_PACKAGING_PRESET=test (or clear it to use ${join(appDesktop, localName)})`)
      return
    }
    const configDir = process.env.DSH_PACKAGING_CONFIG_DIR
    if (!configDir || !isAbsolute(configDir)) {
      record('dotenv', 'FAIL', `machine preset mode selected but DSH_PACKAGING_CONFIG_DIR is unset or relative`,
        `$env:DSH_PACKAGING_CONFIG_DIR='<absolute machine configuration directory>'  # must contain presets\\${preset}.env`)
      return
    }
    path = join(configDir, 'presets', `${preset}.env`)
    if (!existsSync(path)) {
      record('dotenv', 'FAIL', `machine preset selected but ${path} does not exist`,
        `Create presets\\${preset}.env under ${configDir} (accepts the narrow key list of desktop-package-environment.mjs:58-60), or clear DSH_PACKAGING_PRESET to use ${join(appDesktop, localName)}`)
      return
    }
    accepts = name => PRESET_SETTING.test(name) || PUBLIC_PLATFORM_SETTING.test(name)
  } else {
    path = join(appDesktop, localName)
    if (!existsSync(path)) {
      record('dotenv', 'FAIL', `${path} does not exist; the packaging loader refuses to start without it`,
        `Copy-Item "${appDesktop}\\${templateName}" "${path}"  # then fill in this machine's values, or select a machine preset`)
      return
    }
    accepts = name => SHARED_SETTING.test(name) || (process.platform === 'darwin' ? MACOS_SETTING : WINDOWS_SETTING).test(name)
  }
  let settings
  try { settings = parseEnv(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')) }
  catch {
    record('dotenv', 'FAIL', `${path} has invalid dotenv syntax`, `Fix the syntax in ${path}; each line must be key=value with no stray whitespace`)
    return
  }
  const unknown = Object.keys(settings).filter(name => !accepts(name))
  if (unknown.length > 0) {
    record('dotenv', 'FAIL', `unsupported setting keys in ${path}: ${unknown.join(', ')}`,
      `Remove or comment out the unsupported keys in ${path}; the accepted key list is mirrored from desktop-package-environment.mjs:17-21`)
    return
  }
  if (Object.values(settings).some(value => String(value).includes('\0'))) {
    record('dotenv', 'FAIL', `a value in ${path} contains a NUL character`, `Remove the NUL character from ${path}`)
    return
  }
  if (preset !== undefined && settings.DSH_DESKTOP_AUTO_UPDATE_ENV !== preset) {
    record('dotenv', 'FAIL', `preset deployment must match its name (desktop-package-environment.mjs:62): ${path} sets DSH_DESKTOP_AUTO_UPDATE_ENV=${settings.DSH_DESKTOP_AUTO_UPDATE_ENV ?? '(unset)'} but the preset is ${preset}`,
      `Set DSH_DESKTOP_AUTO_UPDATE_ENV=${preset} in ${path}`)
    return
  }
  const problems = configProblem(settings, { requirePolicy: true })
  if (problems.length > 0) {
    record('dotenv', 'FAIL', `policy configuration in ${path} is not self-consistent: ${problems.join('; ')}`,
      `Correct ${path} per the policy rules in desktop-policy-environment.mjs (HTTPS origin without credentials/path/query/fragment; test requires nonempty allowedAuthOrigins; production must not set it)`)
    return
  }
  const secretsName = process.platform === 'darwin' ? 'macos-signing.env' : 'windows-signing.env'
  const secretsNote = preset === undefined ? '' : `; ${join(process.env.DSH_PACKAGING_CONFIG_DIR, 'secrets', secretsName)} ${existsSync(join(process.env.DSH_PACKAGING_CONFIG_DIR, 'secrets', secretsName)) ? 'present (needed only for signed builds)' : 'absent (unsigned builds do not need it)'}`
  const deployment = settings.DSH_DESKTOP_AUTO_UPDATE_ENV ?? 'test'
  if (deployment === 'test') {
    const missingTestKeys = ['DOWNLOAD_TEST_ORIGIN', 'DOWNLOAD_TEST_RELEASE_ID']
      .filter(name => settings[name] === undefined || String(settings[name]).trim() === '')
    if (missingTestKeys.length > 0) {
      record('dotenv', 'FAIL',
        `the test deployment requires ${missingTestKeys.join(' and ')} but ${path} does not set ${missingTestKeys.length > 1 ? 'them' : 'it'}; check:package fails on exactly this (the direct cause of the 1.5.3 packaging stop)`,
        `Copy these two lines from ${join(appDesktop, templateName)} into ${path}: DOWNLOAD_TEST_ORIGIN=... and DOWNLOAD_TEST_RELEASE_ID=... (the template ships placeholder example values; replace both with this deployment's real values before signing or upload)`)
      return
    }
    // A nonblank PACKAGE_TEST_RELEASE_ID replaces the file value in the loader
    // (desktop-package-environment.mjs:71-76), so its format is what counts.
    const override = process.env.PACKAGE_TEST_RELEASE_ID?.trim()
    const releaseSource = override ? 'PACKAGE_TEST_RELEASE_ID (environment override)' : `DOWNLOAD_TEST_RELEASE_ID in ${path}`
    if (!/^[a-f0-9]{32}$/u.test(override || String(settings.DOWNLOAD_TEST_RELEASE_ID).trim())) {
      record('dotenv', 'FAIL', `${releaseSource} is not 32 lowercase hexadecimal characters; the test deployment rejects it`,
        `Set a real 32-character lowercase hex release id in ${override ? 'PACKAGE_TEST_RELEASE_ID' : path}. The template placeholder in ${join(appDesktop, templateName)} is 32 zeros, which only satisfies the format; replace it with the real release id. The authoritative check remains pnpm --dir apps/desktop run check:package; doctor does not copy its allowlist or rules`)
      return
    }
  }
  record('dotenv', 'PASS', `${path} parses, all keys accepted, policy rules self-consistent (key names only: ${Object.keys(settings).join(', ')})${secretsNote}`, undefined)
}

// ---------------------------------------------------------------------------
// 3. Node engines from the workspace root package.json.
// ---------------------------------------------------------------------------
const versionTriple = value => {
  const [raw] = String(value).replace(/^v/u, '').split('-')
  return raw.split('.').map(Number)
}
const compareTriples = (left, right) => {
  const padded = [...left, ...Array(Math.max(0, 3 - left.length))].map((value, index) => value ?? right[index] ?? 0)
  for (let index = 0; index < 3; index += 1) {
    if (padded[index] !== (right[index] ?? 0)) return padded[index] < (right[index] ?? 0) ? -1 : 1
  }
  return 0
}
const satisfies = (version, range) => range.split('||').some(clause => {
  const parts = clause.trim().split(/\s+/)
  return parts.every(part => {
    const match = /^(>=|\^|~)?\s*(\d+(?:\.\d+){0,2})$/u.exec(part)
    if (match === null) return false
    const comparison = compareTriples(versionTriple(version), versionTriple(match[2]))
    if (match[1] === '>=') return comparison >= 0
    if (match[1] === '^') return comparison >= 0 && versionTriple(version)[0] === versionTriple(match[2])[0]
    if (match[1] === '~') return comparison >= 0 && versionTriple(version)[0] === versionTriple(match[2])[0]
      && versionTriple(version)[1] === versionTriple(match[2])[1]
    return comparison === 0
  })
})

const checkNode = () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const range = manifest.engines?.node
  const version = process.version
  if (range !== undefined && satisfies(version, range)) {
    record('node', 'PASS', `node ${version} satisfies engines.node "${range}" (workspace package.json)`, undefined)
  } else {
    record('node', 'FAIL', `node ${version} does not satisfy engines.node "${range ?? '(missing)'}"`,
      `Install Node 22.19+ or 24+ from https://nodejs.org and put it first on PATH`)
  }
}

const checkPnpm = () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const pinned = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[1] : undefined
  const result = run('pnpm', ['--version'])
  if (!result.ok) {
    record('pnpm', 'FAIL', `pnpm is not runnable (npm i -g pnpm@${pinned ?? '11'} installs the pinned version)`,
      `npm i -g pnpm@${pinned ?? 'latest'}  # or: corepack enable && corepack prepare pnpm@${pinned ?? 'latest'} --activate`)
    return
  }
  const actual = result.stdout.trim().split(/\r?\n/).at(-1)
  if (pinned !== undefined && actual !== pinned) {
    record('pnpm', 'WARN', `pnpm ${actual} differs from the pinned packageManager "${manifest.packageManager}"; the bundled runtime uses the pinned version, scripts use the global one`,
      `npm i -g pnpm@${pinned}  # align the global CLI with the pin`)
  } else {
    record('pnpm', 'PASS', `pnpm ${actual} matches the pinned packageManager`, undefined)
  }
}

// ---------------------------------------------------------------------------
// 5. Disk headroom on the repo drive and the temp drive.
// ---------------------------------------------------------------------------
const checkDisk = async () => {
  const { statfs } = await import('node:fs/promises')
  const targets = [['repo', repo], ['temp', tmpdir()]]
  for (const [name, path] of targets) {
    try {
      const stats = await statfs(path)
      const freeGb = (stats.bsize * stats.bavail) / 1024 ** 3
      const status = freeGb >= 3 ? 'PASS' : freeGb >= 1 ? 'WARN' : 'FAIL'
      const note = status === 'PASS' ? undefined : status === 'WARN'
        ? `free ${freeGb.toFixed(1)} GB on the ${name} drive is below the 3 GB recommendation; packaging (electron + builder + runtime) can exhaust it mid-run`
        : `free ${freeGb.toFixed(1)} GB on the ${name} drive is critically low; packaging will fail partway`
      record(`disk-${name}`, status, `free ${freeGb.toFixed(1)} GB at ${path}`, note
        ? `Free space on the ${name} drive (clear old .desktop-build targets, pnpm store, or electron caches)`
        : undefined)
    } catch (error) {
      record(`disk-${name}`, 'WARN', `could not stat the ${name} drive at ${path}: ${error.message}`, undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Electron mirror/cache coupling. The @electron/get cache key is the sha256
//    of the download URL directory, so changing ELECTRON_MIRROR invalidates the
//    whole cache; the symptom is a long silent stall then a timeout.
// ---------------------------------------------------------------------------
const checkMirrors = () => {
  const mirror = process.env.ELECTRON_MIRROR
  const builderMirror = process.env.ELECTRON_BUILDER_BINARIES_MIRROR
  const cacheDir = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron', 'Cache')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'electron')
      : join(homedir(), '.cache', 'electron')
  const cacheBytes = directorySize(cacheDir)
  const cacheText = cacheBytes === undefined ? 'absent (nothing downloaded yet)' : `${(cacheBytes / 1024 ** 2).toFixed(0)} MB`
  const detail = `ELECTRON_MIRROR=${mirror ?? '(unset, downloads from github.com/electron)'}; ELECTRON_BUILDER_BINARIES_MIRROR=${builderMirror ?? '(unset)'}; cache ${cacheDir}: ${cacheText}`
  if (mirror === undefined) {
    record('mirrors', 'WARN', `${detail}. Direct GitHub downloads fail on many networks; set both mirrors and keep them stable`,
      `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`)
  } else {
    record('mirrors', 'PASS', `${detail}. Cache keys derive from the download URL, so changing a mirror later invalidates the cache and re-downloads everything (symptom: a long silent stall then a timeout)`, undefined)
  }
}

// ---------------------------------------------------------------------------
// 7. Proxy with loopback bypass. Packaging downloads usually need the proxy,
//    but loopback traffic (the packaged app's local webserver and license/
//    policy probes) must bypass it. Proxied loopback sessions were the crash
//    mechanism in the 1.5.3 startup-crash incident; a missing NO_PROXY bypass
//    is one contributing factor, not a proven root cause on that machine.
// ---------------------------------------------------------------------------
// A proxy URL can embed user:password credentials; only the endpoint is echoed.
const maskProxy = value => {
  try {
    const url = new URL(value)
    if (url.host !== '' && /^https?:$|^socks[45]:$/u.test(url.protocol)) return `${url.protocol}//${url.host}`
  } catch {
    // Unparseable proxy values fall through to the userinfo strip below.
  }
  // Drop everything up to the last "@" so a password containing "/" or "@",
  // or a scheme new URL() rejects, still never reaches the output.
  const at = value.lastIndexOf('@')
  if (at === -1) return value
  return `${/^[a-z][a-z0-9+.-]*:\/\//iu.exec(value)?.[0] ?? ''}${value.slice(at + 1)}`
}

// NO_PROXY is a comma-separated list matched case-insensitively against the
// host: an entry matches exactly or, with a leading dot, as a suffix on a dot
// boundary. `*` bypasses every host and `<-loopback>` re-enables proxying for
// loopback (curl semantics). Substring containment is not bypass evidence.
const noProxyBypasses = (noProxy, host) => {
  const entries = noProxy.split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '')
  if (entries.includes('<-loopback>')) return false
  if (entries.includes('*')) return true
  return entries.some(entry => {
    const name = (entry.startsWith('.') ? entry.slice(1) : entry).replace(/^\[|\]$/gu, '')
    return host === name || host.endsWith(`.${name}`)
  })
}

const checkProxy = () => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  if (proxy === undefined || proxy.trim() === '') {
    record('proxy', 'PASS', `no proxy configured; downloads go direct. On restricted networks set HTTPS_PROXY and the loopback bypass together`, undefined)
    return
  }
  const missing = ['localhost', '127.0.0.1', '::1'].filter(host => !noProxyBypasses(noProxy, host))
  if (missing.length === 0) {
    record('proxy', 'PASS', `proxy ${maskProxy(proxy)} with NO_PROXY bypassing localhost, 127.0.0.1, ::1`, undefined)
  } else {
    const loopbackOff = noProxy.split(',').map(entry => entry.trim().toLowerCase()).includes('<-loopback>')
    record('proxy', 'FAIL', `proxy ${maskProxy(proxy)} is set but NO_PROXY does not bypass ${missing.join(', ')}${loopbackOff ? '; the <-loopback> entry re-enables proxying for loopback hosts' : ''}; loopback traffic would be routed through the proxy, the mechanism behind the 1.5.3 startup-crash incident (a missing bypass is one contributing factor, not a proven root cause on that machine)`,
      `$env:NO_PROXY='localhost,127.0.0.1,::1'; $env:no_proxy='localhost,127.0.0.1,::1'  # persist it in the user environment`)
  }
}

// ---------------------------------------------------------------------------
// 8. Path hygiene and Defender real-time scanning.
// ---------------------------------------------------------------------------
const checkPaths = () => {
  const problems = []
  if (/[^\u0000-\u007f]/u.test(repo)) problems.push('the repository path contains non-ASCII characters; native build tools and the installer compiler can fail on them')
  if (repo.length > 120) problems.push(`the repository path is ${repo.length} characters; electron-builder's nested output paths can exceed MAX_PATH`)
  if (problems.length > 0) {
    record('paths', 'FAIL', problems.join('; '),
      `Clone the repository into a short ASCII path, e.g. git clone <url> D:\\build\\cadre-heihei`)
  } else {
    record('paths', 'PASS', `repository path ${repo} is ASCII and ${repo.length} characters long`, undefined)
  }
  const defender = run('powershell', ['-NoProfile', '-Command', "try { (Get-MpPreference).DisableRealtimeMonitoring } catch { 'unknown' }"], { timeout: 30_000 })
  if (defender.ok && defender.stdout.includes('True')) {
    record('defender', 'PASS', 'Defender real-time monitoring is disabled on this machine', undefined)
  } else {
    const reason = !defender.ok ? `could not be queried: ${defender.error?.code ?? defender.error?.message ?? 'unknown'}` : defender.stdout.includes('False') ? 'enabled' : 'could not be queried: unexpected answer'
    record('defender', 'WARN', `Defender real-time scanning is ${reason}; scanning the huge .desktop-build tree slows packaging noticeably`,
      `Run an elevated PowerShell: Add-MpPreference -ExclusionPath "${repo}" -ExclusionProcess node.exe`)
  }
}

// ---------------------------------------------------------------------------
// 9. What the artifact manifest records: Git dirty state, and the source
//    commit with its fallbacks (CADRE_SOURCE_COMMIT, then 'unknown').
// ---------------------------------------------------------------------------
const checkGit = () => {
  const git = run('git', ['rev-parse', '--show-toplevel'], { cwd: repo })
  if (!git.ok) {
    // A tree without Git history packages with a fallback commit (P0-3); the
    // source-commit check below owns that classification and its fix commands.
    return
  }
  const toplevel = git.stdout.trim().split(/\r?\n/).at(-1) ?? resolve(repo, '..')
  const status = run('git', ['status', '--porcelain'], { cwd: toplevel })
  const lines = status.stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) {
    record('git', 'PASS', `working tree at ${toplevel} is clean; artifact manifests will record dshBuildDirty=false`, undefined)
  } else {
    record('git', 'WARN', `working tree at ${toplevel} is dirty (${lines.length} entries); builds record dshBuildDirty=true and dshBuildCommit in the artifact manifest, which blocks trusted releases`,
      `git -C ${toplevel} status --porcelain  # commit, stash, or restore before packaging a release`)
  }
}

// Mirrors readDesktopBuildCommit (apps/desktop/scripts/desktop-build-commit.mjs):
// Git first; without Git history CADRE_SOURCE_COMMIT, else 'unknown'. The
// not-a-repository / no-commits patterns must stay in sync with that file.
const checkSourceCommit = () => {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repo })
  if (head.ok) {
    record('source-commit', 'PASS', `build commit ${head.stdout.trim()} comes from the Git checkout at ${repo}`, undefined)
    return
  }
  const noHistory = /not a git repository|ambiguous argument|unknown revision/iu.test(head.stderr)
  if (!noHistory) {
    const reason = head.error?.code ?? head.stderr.trim().split(/\r?\n/).at(-1) ?? 'unknown error'
    record('source-commit', 'FAIL', `git could not read HEAD at ${repo}: ${reason}`,
      `Install git and put it on PATH; packaging reads the build commit with git rev-parse`)
    return
  }
  const override = process.env.CADRE_SOURCE_COMMIT?.trim()
  if (override === undefined || override === '') {
    record('source-commit', 'WARN', `${repo} has no Git history and CADRE_SOURCE_COMMIT is unset: unsigned builds record commit 'unknown' with a warning and the client build step then fails without a real commit; release builds fail until the commit is real`,
      `$env:CADRE_SOURCE_COMMIT='<40-hex commit hash being packaged>'  # or git clone <url> and package inside the clone`)
    return
  }
  if (!/^[0-9a-f]{40}$/u.test(override)) {
    record('source-commit', 'FAIL', `CADRE_SOURCE_COMMIT is "${override}", which is not a 40-hex commit hash; packaging refuses it in every mode`,
      `$env:CADRE_SOURCE_COMMIT='<40-hex commit hash being packaged>'`)
    return
  }
  record('source-commit', 'PASS', `build commit ${override} comes from CADRE_SOURCE_COMMIT (the tree at ${repo} has no Git history, so the manifest records dshBuildDirty=false)`, undefined)
}

// ---------------------------------------------------------------------------
// 0. The repository's own configuration authority: check:package.
// ---------------------------------------------------------------------------
const checkPackageCommand = () => {
  if (!existsSync(join(appDesktop, 'node_modules'))) {
    record('check:package', 'FAIL', `apps/desktop/node_modules is missing; check:package (and every packaging script) needs dependencies installed`,
      `pnpm --dir "${repo}" install`)
    return
  }
  const result = run('pnpm', ['--dir', appDesktop, 'run', 'check:package'], { cwd: repo, timeout: 240_000 })
  if (result.ok) {
    record('check:package', 'PASS', `pnpm --dir apps/desktop run check:package exited 0: the repository's own packaging configuration validation passed`, undefined)
    return
  }
  if (result.error?.code === 'ETIMEDOUT') {
    record('check:package', 'FAIL', `check:package did not finish within 240 s; without a machine preset, --build-version auto contacts the destination bucket under --check, so this can hang on a broken network`,
      `Check network/proxy, or set DSH_PACKAGING_PRESET + DSH_PACKAGING_CONFIG_DIR to a machine preset, then rerun doctor`)
    return
  }
  const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-8).join(' | ')
  record('check:package', 'FAIL', `check:package exited ${result.status ?? 'with an error'}: ${tail}`,
    `Fix the reported configuration error in the local dotenv file or machine preset; the message names the offending key`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const USAGE = `usage: node doctor.mjs [--repo <desktop-workspace-root>] [--help | -h]

The repository defaults to the current working directory and must contain
package.json and apps/desktop/package.json.

Exit codes: 0 all checks pass, 1 warnings only, 2 at least one failure,
64 invalid invocation.`
if (argError !== undefined) {
  console.error(`package-doctor: ${argError}`)
  console.error(USAGE)
  process.exit(64)
}
if (wantsHelp) {
  console.log(USAGE)
  process.exit(0)
}
if (!existsSync(join(repo, 'package.json')) || !existsSync(join(appDesktop, 'package.json'))) {
  console.error(`package-doctor: ${repo} is not a desktop workspace root (expected package.json and apps/desktop/package.json under it).`)
  console.error(USAGE)
  process.exit(64)
}

checkNode()
checkPnpm()
checkDotenv()
await checkDisk()
checkMirrors()
checkProxy()
checkPaths()
checkGit()
checkSourceCommit()
checkPackageCommand()

for (const { id, status, detail, fix } of results) {
  console.log(`${status.padEnd(4)} ${id.padEnd(14)} ${detail}`)
  if (fix !== undefined) console.log(`     fix: ${fix}`)
}
const fails = results.filter(result => result.status === 'FAIL').length
const warns = results.filter(result => result.status === 'WARN').length
console.log(`\nverdict: ${results.length - fails - warns} PASS, ${warns} WARN, ${fails} FAIL -> exit ${fails > 0 ? 2 : warns > 0 ? 1 : 0}`)
process.exitCode = fails > 0 ? 2 : warns > 0 ? 1 : 0
