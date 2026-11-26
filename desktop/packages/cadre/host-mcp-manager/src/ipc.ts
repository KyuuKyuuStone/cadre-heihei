/**
 * The catalog/get/set/preview/add/edit/remove/test API behind `/cadre/mcp/*`,
 * with the Cadre roster authorization matrix applied server-side.
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'
import { localizedDescription } from './catalog.ts'
import { McpError } from './errors.ts'
import { readSelection, validateSelection, writeSelection } from './selection.ts'
import { addManifest, editManifest, removeManifest } from './write.ts'
import type {
  CatalogScan, ConfigValue, McpAddInput, McpAddResult, McpApi, McpCatalogEntry, McpCatalogInput,
  McpCatalogResult, McpEditInput, McpEditResult, McpGetInput, McpPreviewInput, McpPreviewResult,
  McpPreviewSecret, McpProbe, McpRemoveInput, McpRemoveResult, McpSelection, McpSelectionEntry,
  McpSelectionView, McpServerManifest, McpSetInput, McpTestInput, McpTestResult,
} from './types.ts'

/** Dependencies of the API; `scanCatalog` and `probe` are injected so tests pin them. */
export interface McpIpcDeps {
  readonly db: DatabaseSync
  readonly ledgerPath: string
  readonly serversRoot: string
  scanCatalog(): Promise<CatalogScan>
  probe: McpProbe
}

interface MemberRow { role?: unknown; state?: unknown }

function memberOf(db: DatabaseSync, projectId: string, sessionId: string): MemberRow | undefined {
  try {
    return db.prepare('SELECT role, state FROM members WHERE project_id = ? AND session_id = ? LIMIT 1')
      .get(projectId, sessionId)
  } catch {
    // An older ledger without `members` proves nothing; treat it as off-roster.
    return undefined
  }
}

function assertActive(actor: MemberRow | undefined): void {
  if (actor?.state === 'departed') {
    throw new McpError('MCP_FORBIDDEN', 403, '你已不在该项目中', '请联系主管重新加入项目组')
  }
}

function assertCanTouchTarget(actor: MemberRow | undefined, actorSessionId: string, targetSessionId: string): void {
  if (targetSessionId === actorSessionId) return
  if (actor?.role === 'supervisor') return
  throw new McpError('MCP_FORBIDDEN', 403, '只有主管可以操作其他成员的 MCP 服务器', '请由主管操作')
}

/**
 * Catalog writes and probes act on the machine-wide directory, so they need a
 * supervisor. A non-supervisor is refused even when it sends `confirm: true`.
 * @param actor - the caller's roster row, if the ledger proves one.
 */
function assertSupervisor(actor: MemberRow | undefined): void {
  if (actor?.role === 'supervisor') return
  throw new McpError('MCP_FORBIDDEN', 403, '只有主管可以修改 MCP 目录', '请由主管操作')
}

/**
 * @param confirm - the caller's confirmation flag.
 * @param message - what the caller is about to change.
 */
function assertConfirmed(confirm: unknown, message: string): void {
  if (confirm === true) return
  throw new McpError('MCP_CONFIRM_REQUIRED', 409, `${message}需要 confirm:true`, '预览后带 confirm:true 重试')
}

/**
 * Reduce one config value to its masked reference: the name plus the environment
 * variable it reads, never the literal.
 * @param name - entry name from `env` or `headers`.
 * @param value - the stored reference or non-sensitive literal.
 * @returns the masked row a caller may see.
 */
function maskedSecret(name: string, value: ConfigValue): McpPreviewSecret {
  return typeof value === 'string' ? { name } : { name, fromEnv: value.fromEnv }
}

function previewOf(manifest: McpServerManifest, locale: string | undefined): McpPreviewResult {
  const masked = (values: Readonly<Record<string, ConfigValue>> | undefined): McpPreviewSecret[] =>
    Object.entries(values ?? {}).map(([name, value]) => maskedSecret(name, value))
  return {
    id: manifest.id,
    name: manifest.name,
    description: localizedDescription(manifest, locale),
    transport: manifest.transport,
    tags: manifest.tags ?? [],
    envKeys: masked(manifest.env),
    headerKeys: masked(manifest.headers),
    ...(manifest.command === undefined ? {} : { command: manifest.command }),
    ...(manifest.args === undefined ? {} : { args: manifest.args }),
    ...(manifest.url === undefined ? {} : { url: manifest.url }),
    ...(manifest.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: manifest.toolCallTimeoutMs }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
  }
}

/**
 * Resolve one manifest the operator named, refusing ids the catalog does not hold.
 * @param scan - current catalog scan.
 * @param serverId - id named by the caller.
 * @returns the manifest behind that id.
 */
function manifestOf(scan: CatalogScan, serverId: string): McpServerManifest {
  const manifest = scan.servers.get(serverId)
  if (manifest === undefined) {
    throw new McpError('MCP_SERVER_UNAVAILABLE', 503, `未知 MCP 服务器：${serverId}`, '刷新目录后重试')
  }
  return manifest
}

function entryOf(
  manifest: McpServerManifest,
  chosen: McpSelectionEntry | undefined,
  locale: string | undefined,
): McpCatalogEntry {
  return {
    id: manifest.id,
    name: manifest.name,
    description: localizedDescription(manifest, locale),
    transport: manifest.transport,
    tags: manifest.tags ?? [],
    envKeys: Object.keys(manifest.env ?? {}),
    headerKeys: Object.keys(manifest.headers ?? {}),
    selected: chosen !== undefined,
    enabled: chosen?.enabled ?? false,
    overrides: chosen?.overrides ?? {},
  }
}

/**
 * Build the API over one ledger handle and catalog scan.
 * @param deps - ledger handle, writer path, and catalog scanner.
 * @returns the catalog/get/set surface the routes expose.
 */
export function createMcpApi(deps: McpIpcDeps): McpApi {
  const known = async (): Promise<CatalogScan> => deps.scanCatalog()

  return {
    async catalog(input: McpCatalogInput): Promise<McpCatalogResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      const target = input.targetSessionId ?? input.actorSessionId
      assertCanTouchTarget(actor, input.actorSessionId, target)
      const scan = await known()
      const chosen = new Map(readSelection(deps.db, target).servers.map(entry => [entry.id, entry]))
      return {
        servers: [...scan.servers.values()].map(manifest => entryOf(manifest, chosen.get(manifest.id), input.locale)),
        health: scan.health,
      }
    },

    async get(input: McpGetInput): Promise<McpSelectionView> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertCanTouchTarget(actor, input.actorSessionId, input.targetSessionId)
      const scan = await known()
      const stored = readSelection(deps.db, input.targetSessionId)
      // Project each stored id onto its catalog entry, so the caller reads the
      // description localized for its locale; ids the catalog dropped disappear.
      const servers = stored.servers.flatMap((entry) => {
        const manifest = scan.servers.get(entry.id)
        return manifest === undefined
          ? []
          : [{ ...entry, localizedDescription: localizedDescription(manifest, input.locale) }]
      })
      return { servers }
    },

    async set(input: McpSetInput): Promise<McpSelectionView> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertCanTouchTarget(actor, input.actorSessionId, input.targetSessionId)
      const scan = await known()
      const selection: McpSelection = validateSelection(input.servers, id => scan.servers.has(id))
      writeSelection(deps.ledgerPath, input.targetSessionId, selection)
      return { servers: selection.servers }
    },

    async preview(input: McpPreviewInput): Promise<McpPreviewResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      // A catalog entry belongs to no session, so any roster member may read it;
      // the response carries references only, never a secret value.
      const scan = await known()
      return previewOf(manifestOf(scan, input.serverId), input.locale)
    },

    add(input: McpAddInput): Promise<McpAddResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertSupervisor(actor)
      const overwrite = input.overwrite === true
      // The manifest is validated by the write itself, before any path is named.
      if (overwrite) assertConfirmed(input.confirm, '覆盖 MCP 服务器')
      const written = addManifest(deps.serversRoot, input.manifest, overwrite)
      return Promise.resolve({ id: written.id, created: written.created, overwritten: written.overwritten })
    },

    async edit(input: McpEditInput): Promise<McpEditResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertSupervisor(actor)
      assertConfirmed(input.confirm, `修改 MCP 服务器 ${input.serverId}`)
      manifestOf(await known(), input.serverId)
      const written = editManifest(deps.serversRoot, input.serverId, input.patch)
      return { id: written.id, updated: true }
    },

    async remove(input: McpRemoveInput): Promise<McpRemoveResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertSupervisor(actor)
      // Mirrors the skill catalog's remove: a missing confirmation is an input
      // error there, not a pending confirmation a supervisor still has to give.
      if (input.confirm !== true) {
        throw new McpError('MCP_INVALID', 400, '删除 MCP 服务器需要 confirm:true', '确认要删除后带 confirm:true 重试')
      }
      manifestOf(await known(), input.serverId)
      removeManifest(deps.serversRoot, input.serverId)
      return { removed: true }
    },

    async test(input: McpTestInput): Promise<McpTestResult> {
      const actor = memberOf(deps.db, input.projectId, input.actorSessionId)
      assertActive(actor)
      assertSupervisor(actor)
      assertConfirmed(input.confirm, `测试 MCP 服务器 ${input.serverId}`)
      const manifest = manifestOf(await known(), input.serverId)
      const outcome = await deps.probe(manifest)
      return { ok: true, tools: outcome.tools, instructionBytes: outcome.instructionBytes }
    },
  }
}
