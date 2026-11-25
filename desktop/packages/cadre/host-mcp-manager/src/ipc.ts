/**
 * The catalog/get/set API behind `/cadre/mcp/*`, with the Cadre roster
 * authorization matrix applied server-side.
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'
import { localizedDescription } from './catalog.ts'
import { McpError } from './errors.ts'
import { readSelection, validateSelection, writeSelection } from './selection.ts'
import type {
  CatalogScan, McpApi, McpCatalogEntry, McpCatalogInput, McpCatalogResult, McpGetInput,
  McpSelection, McpSelectionEntry, McpSelectionView, McpSetInput, McpServerManifest,
} from './types.ts'

/** Dependencies of the API; `scanCatalog` is injected so tests can pin a catalog. */
export interface McpIpcDeps {
  readonly db: DatabaseSync
  readonly ledgerPath: string
  scanCatalog(): Promise<CatalogScan>
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
  }
}
