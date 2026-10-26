#!/usr/bin/env node
/**
 * Read-only drift check between the pinned upstream harness and this workspace.
 *
 * The upstream baseline is the commit recorded in `desktop/UPSTREAM.md`.
 * The old `vendor/deepseek-harness` submodule has been removed, so supply a
 * checkout with `--upstream <dir>` (see Usage). This script:
 *   1. lists every file tracked by that commit,
 *   2. compares it byte-for-byte with the same path under `desktop/`,
 *   3. walks `desktop/` for files the pin does not have (added files),
 *   4. reports anything missing from the `UPSTREAM.md` registry tables.
 *
 * It never writes to either tree. Exit code 1 means drift that the registry
 * does not name, which is what a preflight should fail on.
 *
 * Usage:
 *   node desktop/scripts/check-upstream-drift.mjs
 *   node desktop/scripts/check-upstream-drift.mjs --json
 *   node desktop/scripts/check-upstream-drift.mjs --fail-on-drift
 *
 * Options:
 *   --upstream <dir>   upstream checkout (default: <repo>/vendor/deepseek-harness)
 *   --workspace <dir>  our copy (default: <repo>/desktop)
 *   --registry <file>  registry document (default: <workspace>/UPSTREAM.md)
 *   --json             machine-readable output
 *   --fail-on-drift    exit 1 when unregistered changes exist
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** Directories that are build output, dependencies, or local state — never sources. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'lib', 'dist', 'coverage', 'out', 'build',
  '.desktop-build', '.dsh-build', '.spike-build', '.spike-home', '.claude', '.agents',
  '.turbo', '.vite', '.cache', '.idea', '.vscode', 'test-results', 'playwright-report',
  'undefined', 'temp',
])

/**
 * Known build residue: files a build or packaging step dropped into the tree.
 * They are reported separately and never count as registered product changes.
 */
const RESIDUE_PREFIXES = [
  'vendor/package.json',
  'vendor/LICENSE',
  'vendor/tsconfig.json',
  'vendor/src/',
  'vendor/lib/',
]

/** File suffixes owned by the build, not by a person. */
const SKIP_SUFFIXES = ['.map', '.tsbuildinfo', '.log', '.tmp', '.tgz', '.asar']

/** Large binary fixtures we still want to see but not diff byte-wise. */
const MAX_COMPARE_BYTES = 8 * 1024 * 1024

function parseArgs(argv) {
  const options = {
    upstream: join(REPO_ROOT, 'vendor', 'deepseek-harness'),
    workspace: join(REPO_ROOT, 'desktop'),
    registry: undefined,
    json: false,
    failOnDrift: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--upstream') options.upstream = resolve(argv[++index])
    else if (arg === '--workspace') options.workspace = resolve(argv[++index])
    else if (arg === '--registry') options.registry = resolve(argv[++index])
    else if (arg === '--json') options.json = true
    else if (arg === '--fail-on-drift') options.failOnDrift = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  options.registry ??= join(options.workspace, 'UPSTREAM.md')
  return options
}

/** Files tracked by the pinned commit, POSIX separators. */
function upstreamFiles(upstream) {
  const raw = execFileSync('git', ['-C', upstream, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\0').filter(Boolean)
}

function isSkipped(name) {
  return SKIP_DIRS.has(name) || SKIP_SUFFIXES.some(suffix => name.endsWith(suffix))
}

/** Every source-looking file under the workspace, POSIX separators. */
function workspaceFiles(workspace) {
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (isSkipped(entry.name)) continue
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) found.push(relative(workspace, absolute).split(sep).join('/'))
    }
  }
  walk(workspace)
  return found
}

function readOrUndefined(path) {
  try {
    return readFileSync(path)
  } catch {
    return undefined
  }
}

/** Normalize line endings so a CRLF checkout does not read as a change. */
function normalize(body) {
  return body.toString('utf8').replace(/\r\n/gu, '\n')
}

function differs(upstreamBody, workspaceBody) {
  if (upstreamBody.length > MAX_COMPARE_BYTES || workspaceBody.length > MAX_COMPARE_BYTES) {
    return upstreamBody.length !== workspaceBody.length
  }
  return normalize(upstreamBody) !== normalize(workspaceBody)
}

/** A `package.json` whose only difference is its root `version` is a release bump, not a patch. */
function isVersionOnly(path, upstreamBody, workspaceBody) {
  if (!path.endsWith('package.json')) return false
  try {
    const upstream = JSON.parse(upstreamBody.toString('utf8'))
    const workspace = JSON.parse(workspaceBody.toString('utf8'))
    delete upstream.version
    delete workspace.version
    return JSON.stringify(upstream) === JSON.stringify(workspace)
  } catch {
    return false
  }
}

/** A `.js`/`.d.ts`/map beside a same-named `.ts` is compiler output left in `src/`. */
function isGeneratedResidue(path, workspaceFileSet) {
  const match = /^(.*)\.(?:js|d\.ts)(?:\.map)?$/u.exec(path)
  return match !== null && workspaceFileSet.has(`${match[1]}.ts`)
}

/** Paths the registry already names: exact paths or directory prefixes ending in `/`. */
function registeredPaths(registryText) {
  const paths = new Set()
  for (const line of registryText.split('\n')) {
    if (!line.startsWith('|')) continue
    for (const match of line.matchAll(/`([^`]+)`/gu)) {
      const value = match[1].trim()
      if (value.includes('/') || value.includes('.')) paths.add(value.replace(/^\.\//u, ''))
    }
  }
  return paths
}

function isRegistered(path, paths) {
  if (paths.has(path)) return true
  for (const candidate of paths) {
    if (candidate.endsWith('/**') && path.startsWith(candidate.slice(0, -2))) return true
    if (candidate.endsWith('/') && path.startsWith(candidate)) return true
  }
  return false
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.upstream)) {
    console.error(
      `upstream checkout not found: ${options.upstream}\n`
      + 'The vendored submodule was removed; pass --upstream <dir> pointing at a deepseek-harness checkout.',
    )
    process.exit(2)
  }
  const tracked = upstreamFiles(options.upstream)
  const modified = []
  const versionOnly = []
  const deleted = []
  const identical = []

  for (const path of tracked) {
    const upstreamBody = readOrUndefined(join(options.upstream, path))
    const workspaceBody = readOrUndefined(join(options.workspace, path))
    if (workspaceBody === undefined) deleted.push(path)
    else if (upstreamBody === undefined) modified.push(path)
    else if (differs(upstreamBody, workspaceBody)) {
      if (isVersionOnly(path, upstreamBody, workspaceBody)) versionOnly.push(path)
      else modified.push(path)
    } else identical.push(path)
  }

  const trackedSet = new Set(tracked)
  const workspaceAll = workspaceFiles(options.workspace)
  const workspaceSet = new Set(workspaceAll)
  const added = []
  const residue = []
  for (const path of workspaceAll) {
    if (trackedSet.has(path)) continue
    const known = RESIDUE_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix))
    if (known || isGeneratedResidue(path, workspaceSet)) residue.push(path)
    else added.push(path)
  }

  const registry = registeredPaths(readFileSync(options.registry, 'utf8'))
  const registryPath = relative(options.workspace, options.registry).split(sep).join('/')
  const unregistered = [...modified, ...deleted, ...added]
    .filter(path => path !== registryPath && !isRegistered(path, registry))

  const report = { modified, versionOnly, deleted, added, residue, unregistered, identical: identical.length, tracked: tracked.length }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const section = (title, list) => {
      console.log(`\n## ${title} (${list.length})`)
      for (const path of list) console.log(`- ${path}`)
    }
    console.log(`upstream:  ${options.upstream}`)
    console.log(`workspace: ${options.workspace}`)
    console.log(`registry:  ${options.registry}`)
    console.log(`tracked files at pin: ${tracked.length}; identical: ${identical.length}`)
    section('modified', modified)
    section('version-only package.json', versionOnly)
    section('deleted', deleted)
    section('added', added)
    section('build residue (not a product change)', residue)
    section('UNREGISTERED (missing from UPSTREAM.md)', unregistered)
  }

  if (options.failOnDrift && unregistered.length > 0) process.exitCode = 1
}

main()
