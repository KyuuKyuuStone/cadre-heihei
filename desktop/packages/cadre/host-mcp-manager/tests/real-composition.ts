/**
 * REAL-composition harness for the host-mcp-manager specs.
 *
 * A test-only `cordis.yml` boots through the vendored Loader: the manager row,
 * the real webserver, and the real agent loop all mount from source-plane
 * modules. Test-provided pieces stay at the transport admission seam only; the
 * manager, its ledger, the catalog directory, the MCP server process, and the
 * HTTP server are real.
 * @module
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import WebServerModule from '@deepseek-ai/dsh-host-webserver'
import * as HostMcpManagerModule from '../src/index.ts'

/** Filesystem layout one composition run owns. */
export interface CompositionPaths {
  readonly root: string
  readonly ledgerPath: string
  readonly serversDir: string
}

/** @param prefix - temp directory prefix. @returns a fresh layout with an empty catalog root. */
export async function makeCompositionPaths(prefix: string): Promise<CompositionPaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const serversDir = join(root, 'servers')
  await mkdir(serversDir, { recursive: true })
  return { root, ledgerPath: join(root, 'cadre.sqlite'), serversDir }
}

/** @param root - layout to delete. @returns after deleting it, tolerating Windows handle lag. */
export async function removeCompositionPaths(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100 * (attempt + 1))
      })
    }
  }
}

/** One roster row to seed. */
export interface RosterRow {
  readonly projectId: string
  readonly sessionId: string
  readonly role: 'supervisor' | 'worker'
  readonly state?: 'available' | 'departed'
}

/**
 * Create the ledger with the shipped roster tables and seed them.
 * @param ledgerPath - database to create; the manager opens it read-only at load.
 * @param rows - roster rows; sessions absent here stay off-roster.
 */
export function seedLedger(ledgerPath: string, rows: readonly RosterRow[]): void {
  const seed = new DatabaseSync(ledgerPath)
  try {
    seed.exec(`CREATE TABLE projects (project_id TEXT PRIMARY KEY, archived_at TEXT);
CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id))`)
    for (const row of rows) {
      seed.prepare(`INSERT OR REPLACE INTO members (project_id, session_id, role, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'now', 'now')`).run(row.projectId, row.sessionId, row.role, row.state ?? 'available')
    }
  } finally {
    seed.close()
  }
}

/** One stdio catalog entry the composition can mount. */
export interface StdioServerFixture {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly toolCallTimeoutMs?: number
  readonly description?: string
  readonly descriptionI18n?: { readonly zh?: string; readonly en?: string }
}

/**
 * Write one real catalog directory holding a single stdio manifest.
 * @param serversDir - catalog root.
 * @param fixture - entry to write.
 */
export async function writeStdioServer(serversDir: string, fixture: StdioServerFixture): Promise<void> {
  const dir = join(serversDir, fixture.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
    id: fixture.id,
    name: fixture.name,
    transport: 'stdio',
    command: fixture.command,
    args: [...fixture.args],
    ...(fixture.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: fixture.toolCallTimeoutMs }),
    ...(fixture.description === undefined ? {} : { description: fixture.description }),
    ...(fixture.descriptionI18n === undefined ? {} : { descriptionI18n: fixture.descriptionI18n }),
  }, null, 2)}\n`, 'utf8')
}

/** Mutable admission answer the specs flip to exercise the transport gate. */
export interface AdmissionFlag { reject: boolean }

/** Services the booted context publishes for the specs. */
export interface HostServicesOptions {
  /** When `reject` is true, `connection.admit` answers with a rejection. */
  readonly admission: AdmissionFlag
}

/**
 * The test-only row that provides the admission seam and mounts the real loop.
 * @param options - admission flag the spec flips.
 * @returns a function plugin providing `connection` and the loop driver.
 */
export function hostServices(options: HostServicesOptions): { name: string; apply(ctx: Context): void } {
  return {
    name: 'test:host-services',
    apply(ctx: Context): void {
      // The Loader does not await async row applies, so the admission seam the
      // manager's routes need is provided synchronously; the loop mounts detached
      // and the specs wait for `testLoop`.
      ctx.provide('connection', {
        admit: () => (options.admission.reject ? { rejection: 403 } : undefined),
      })
      void (async (): Promise<void> => {
        await mountAgentLoopTestDependencies(ctx)
        await mountAgentLoopTestHarness(ctx)
        // `ctx.get` reads the global store; the testkit's own `create` closes over this
        // plugin context, whose `ctx.agentLoop` property access needs a declared injection.
        const loop = ctx.get('agentLoop') as {
          create(id: SessionId, options?: unknown, meta?: unknown): Promise<unknown>
        } | undefined
        if (loop === undefined) throw new Error('agentLoop did not mount')
        ctx.provide('testLoop', {
          create: (id: SessionId, options?: unknown, meta?: unknown) => loop.create(id, options, meta),
        })
      })()
    },
  }
}

/**
 * @param options - layout paths and the admission flag.
 * @returns the yml rows in load order.
 */
export function compositionRows(options: CompositionPaths & { readonly admission: AdmissionFlag }): string[] {
  return [
    "- name: 'test:host-services'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-mcp-manager'",
    '  config:',
    `    ledgerPath: '${options.ledgerPath}'`,
    `    mcpDir: '${options.serversDir}'`,
  ]
}

/**
 * @param admission - the same flag the rows' host-services plugin reads.
 * @returns the yml specifier to source-plane module map.
 */
export function compositionModules(admission: AdmissionFlag): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ['test:host-services', hostServices({ admission })],
    ['@deepseek-ai/dsh-host-webserver', WebServerModule],
    ['@deepseek-ai/dsh-host-mcp-manager', HostMcpManagerModule],
  ])
}

/**
 * Boot one composition: yml rows through the real Loader, every row resolved
 * from the caller-supplied map (source plane, no build step).
 * @param options - layout root, rows, modules.
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

/**
 * @param context - booted composition.
 * @param name - service key.
 * @returns that service as `unknown`; callers narrow with one cast.
 */
export function serviceOf(context: Context, name: string): unknown {
  const service: unknown = context.get(name)
  if (service === undefined) throw new Error(`service did not mount: ${name}`)
  return service
}

/**
 * Wait until one service appears in the global store.
 * @param context - booted composition.
 * @param name - service key to wait for.
 * @param timeoutMs - failure deadline.
 */
export async function waitForService(context: Context, name: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (context.get(name) === undefined) {
    if (Date.now() > deadline) throw new Error(`service did not mount within ${timeoutMs}ms: ${name}`)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }
}

/** Decoded JSON reply from one real HTTP call. */
export interface HttpReply {
  readonly status: number
  readonly text: string
  readonly ok?: boolean
  readonly code?: string
  readonly message?: string
  readonly remediation?: string
  readonly result?: unknown
}

/**
 * @param origin - webserver origin from `webServer.getOrigin()`.
 * @param path - route path.
 * @param body - JSON body, or undefined for a bodyless call.
 * @param method - HTTP method.
 * @returns the decoded reply, keeping raw `text` as evidence for non-JSON answers.
 */
export async function callRoute(
  origin: string,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<HttpReply> {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload: { ok?: boolean; code?: string; message?: string; remediation?: string; result?: unknown } = {}
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    // A non-JSON body (an empty 404, for example) keeps `text` as the evidence.
  }
  return {
    status: response.status,
    text,
    ...(payload.ok === undefined ? {} : { ok: payload.ok }),
    ...(payload.code === undefined ? {} : { code: payload.code }),
    ...(payload.message === undefined ? {} : { message: payload.message }),
    ...(payload.remediation === undefined ? {} : { remediation: payload.remediation }),
    ...(payload.result === undefined ? {} : { result: payload.result }),
  }
}
