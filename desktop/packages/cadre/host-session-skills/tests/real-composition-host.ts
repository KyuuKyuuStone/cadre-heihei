/**
 * Shared REAL-composition boot harness for the host-session-skills specs.
 *
 * A test-only cordis.yml boots through the vendored Loader next to real Host
 * services; `modules` maps every yml row specifier to its source-plane module,
 * so no build step is involved. Test-provided pieces stay at the transport
 * admission seam and model-facing externals — the plugin under test, its
 * ledger, the skill directories, and the HTTP server are real.
 * @module
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

/** Filesystem layout one composition run owns. */
export interface CompositionPaths {
  readonly root: string
  readonly ledgerPath: string
  readonly skillsDir: string
  readonly builtinDir: string
  readonly auditDir: string
}

/** @returns a fresh temp composition layout with empty skill directories. */
export async function makeCompositionPaths(prefix: string): Promise<CompositionPaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const ledgerPath = join(root, 'cadre.sqlite')
  const skillsDir = join(root, 'installed')
  const builtinDir = join(root, 'builtin')
  const auditDir = join(root, 'audit')
  for (const dir of [skillsDir, builtinDir, auditDir]) await mkdir(dir, { recursive: true })
  return { root, ledgerPath, skillsDir, builtinDir, auditDir }
}

/** @returns after deleting the layout, tolerating Windows read-handle lag. */
export async function removeCompositionPaths(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve: (value: void) => void) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

/** One roster row to seed into the ledger. */
export interface LedgerSeedRow {
  readonly projectId: string
  readonly sessionId: string
  readonly role: 'supervisor' | 'worker'
  readonly state?: 'available' | 'departed'
}

/**
 * Seed the shipped v3 roster schema (projects + members) with the given rows.
 * @param ledgerPath - ledger database to create and seed.
 * @param rows - roster rows; sessions absent here stay off-roster.
 */
export function seedLedger(ledgerPath: string, rows: readonly LedgerSeedRow[]): void {
  const seed = new DatabaseSync(ledgerPath)
  try {
    seed.exec(`CREATE TABLE projects (project_id TEXT PRIMARY KEY, archived_at TEXT);
CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id))`)
    for (const row of rows) {
      seed.prepare(`INSERT INTO members (project_id, session_id, role, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'now', 'now')`).run(row.projectId, row.sessionId, row.role, row.state ?? 'available')
    }
  } finally {
    seed.close()
  }
}

/** One on-disk skill pack fixture. */
export interface SkillPackFixture {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** @returns after writing one real skill pack (manifest.json + SKILL.md) on disk. */
export async function writeSkillPack(dir: string, pack: SkillPackFixture): Promise<void> {
  const packDir = join(dir, pack.id)
  await mkdir(packDir, { recursive: true })
  const manifest = {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    roles: ['supervisor', 'worker'],
    tokenEstimate: 42,
    tools: [],
    source: 'test-suite',
    license: 'MIT',
  }
  await writeFile(join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(packDir, 'SKILL.md'), `# ${pack.name}\n\n${pack.description}\n`, 'utf8')
}

/**
 * Boot one test-only composition: yml rows through the real Loader; every row
 * module resolves from the caller-supplied map (source plane).
 * @param options.root - layout directory that carries cordis.yml.
 * @param options.rows - literal yml row lines in load order.
 * @param options.modules - yml row specifier to module record.
 * @returns the booted context; the caller owns `context.fiber.dispose()`.
 */
export async function bootComposition(options: {
  root: string
  rows: readonly string[]
  modules: ReadonlyMap<string, unknown>
}): Promise<Context> {
  await mkdir(options.root, { recursive: true })
  const configPath = join(options.root, 'cordis.yml')
  await writeFile(configPath, `${options.rows.join('\n')}\n`, 'utf8')
  const context = new Context()
  context.baseUrl = pathToFileURL(options.root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = options.modules
  Object.defineProperty(context.loader, 'internal', {
    value: {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    },
  })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/** One file of a snapshotted directory tree. */
export interface TreeEntry {
  /** Path relative to the snapshot root, `/`-separated, in sort order. */
  readonly path: string
  /** Exact file bytes, so later comparisons prove content identity. */
  readonly bytes: Buffer
}

/**
 * Recursively snapshot one directory tree (relative paths plus exact bytes).
 * @param root - directory to walk; missing directories reject like plain fs reads.
 * @returns entries sorted by relative path, ready for deep equality comparison.
 */
export async function snapshotTree(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(child, rel)
      else if (entry.isFile()) entries.push({ path: rel, bytes: await readFile(child) })
    }
  }
  await walk(root, '')
  entries.sort((first, second) => first.path.localeCompare(second.path))
  return entries
}

/** Decoded JSON reply from one real HTTP call against the booted webserver. */
export interface HttpReply {
  readonly status: number
  readonly text: string
  readonly ok?: boolean
  readonly code?: string
  readonly message?: string
  readonly result?: unknown
}

/** @returns the decoded JSON reply of one real POST against the webserver origin. */
export async function postJson(origin: string, path: string, body: unknown): Promise<HttpReply> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload: { ok?: boolean; code?: string; message?: string; result?: unknown } = {}
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    // A non-JSON body (for example an empty 404) keeps `text` as the evidence.
  }
  return {
    status: response.status,
    text,
    ...(payload.ok === undefined ? {} : { ok: payload.ok }),
    ...(payload.code === undefined ? {} : { code: payload.code }),
    ...(payload.message === undefined ? {} : { message: payload.message }),
    ...(payload.result === undefined ? {} : { result: payload.result }),
  }
}

/**
 * @param context - booted composition context.
 * @param name - service key.
 * @returns one named service from the booted composition, typed by the caller.
 */
export function serviceOf<T>(context: Context, name: string): T {
  const service: T | undefined = context.get(name)
  if (service === undefined) throw new Error(`service did not mount: ${name}`)
  return service
}

/**
 * Wait until one service appears in the global store. Services whose declared
 * injections activate later than `loader.await()` need this before use.
 * @param context - booted composition context.
 * @param name - service key to wait for.
 * @param timeoutMs - failure deadline.
 */
export async function waitForService(context: Context, name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (context.get(name) === undefined) {
    if (Date.now() > deadline) throw new Error(`service did not mount within ${timeoutMs}ms: ${name}`)
    await new Promise((resolve: (value: void) => void) => setTimeout(resolve, 50))
  }
}
