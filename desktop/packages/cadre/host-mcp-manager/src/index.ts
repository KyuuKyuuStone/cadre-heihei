/**
 * Cadre MCP manager: the machine-local catalog plus each session's selection,
 * mounted as `mcp-client` child fibers in that session's agent scope.
 *
 * The manager owns catalog, selection, and lifecycle only. Connections, tool
 * naming, reconnection, and environment scrubbing stay in `mcp-client`, so a
 * single step never runs two competing connection state machines.
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCatalog, resolveServersRoot } from './catalog.ts'
import { McpError } from './errors.ts'
import { createMcpApi, type McpIpcDeps } from './ipc.ts'
import { resolveServer, SelectionMounter } from './mount.ts'
import { openLedger, readSelection } from './selection.ts'
import type { AgentSurface, HostContext, PreStepPayload, ResolvedServer } from './types.ts'

/** Plugin config; every field falls back to the environment, then to a home-relative default. */
export interface Config {
  /** `false` leaves the host without a manager. */
  enabled?: boolean
  /** Catalog root; overrides `CADRE_MCP_DIR`. */
  mcpDir?: string
  /** Cadre ledger path; overrides `CADRE_LEDGER_PATH`. */
  ledgerPath?: string
}

const BODY_LIMIT_BYTES = 16_384

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) throw new McpError('MCP_INVALID', 400, '请求体过大', '减少提交的字段')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpError('MCP_INVALID', 400, '请求体必须是对象', '提交 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function required(body: Record<string, unknown>, name: string): string {
  if (typeof body[name] !== 'string' || (body[name]) === '') {
    throw new McpError('MCP_INVALID', 400, `${name} 必填`, `补齐 ${name} 后重试`)
  }
  return body[name]
}

/**
 * Register the `/cadre/mcp/*` routes once `webServer` and `connection` exist.
 * @param scope - injected scope carrying both services.
 * @param deps - ledger handle, writer path, and catalog scanner.
 */
function registerRoutes(scope: unknown, deps: McpIpcDeps): void {
  const web = scope as {
    webServer: {
      register(route: {
        kind: 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
    connection: { admit(req: IncomingMessage): unknown }
    effect(setup: () => () => void, label: string): () => void
  }
  const api = createMcpApi(deps)
  const route = (path: string, operation: (body: Record<string, unknown>) => unknown): void => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST', remediation: '改用 POST' })
          return
        }
        const admission = web.connection.admit(req)
        if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
          reply(res, (admission as { rejection: number }).rejection, {
            ok: false, code: 'FORBIDDEN', message: '未授权', remediation: '确认本机来源后重试',
          })
          return
        }
        try {
          reply(res, 200, { ok: true, result: await operation(await readBody(req)) })
        } catch (error) {
          if (error instanceof McpError) {
            reply(res, error.status, {
              ok: false, code: error.code, message: error.message, remediation: error.remediation,
            })
            return
          }
          reply(res, 500, {
            ok: false,
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error),
            remediation: '查看宿主日志后重试',
          })
        }
      },
    }), `host-mcp-manager: ${path}`)
  }
  route('/cadre/mcp/catalog', body => api.catalog({
    projectId: required(body, 'projectId'),
    actorSessionId: required(body, 'actorSessionId'),
    ...(typeof body.targetSessionId === 'string' ? { targetSessionId: body.targetSessionId } : {}),
    ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
  }))
  route('/cadre/mcp/get', body => api.get({
    projectId: required(body, 'projectId'),
    actorSessionId: required(body, 'actorSessionId'),
    targetSessionId: required(body, 'targetSessionId'),
  }))
  route('/cadre/mcp/set', body => api.set({
    projectId: required(body, 'projectId'),
    actorSessionId: required(body, 'actorSessionId'),
    targetSessionId: required(body, 'targetSessionId'),
    servers: body.servers,
  }))
}

/**
 * Mount each session's selected servers before every step.
 * @param ctx - host context carrying `agent/pre-step` and the web services.
 * @param config - catalog root, ledger path, and the enable switch.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const ledgerPath = config.ledgerPath ?? process.env.CADRE_LEDGER_PATH?.trim()
  if (ledgerPath === undefined || ledgerPath === '') {
    console.error('host-mcp-manager: CADRE_LEDGER_PATH is unset; no MCP servers will mount')
    return
  }
  const serversRoot = resolveServersRoot(config)
  const db = openLedger(ledgerPath)
  const mounter = new SelectionMounter()
  const scanCatalog = () => readCatalog(serversRoot)

  // Read-only for consumers: the selection is data, not a model-facing prompt.
  ctx.provide?.('mcpSelection', {
    selectedFor: (sessionId: string): readonly string[] =>
      readSelection(db, sessionId).servers.filter(entry => entry.enabled).map(entry => entry.id),
  })

  const mountFor = async (agent: AgentSurface): Promise<void> => {
    const agentId = agent.id
    const scan = await scanCatalog()
    const desired: ResolvedServer[] = []
    for (const entry of readSelection(db, agentId).servers) {
      if (!entry.enabled) continue
      const manifest = scan.servers.get(entry.id)
      if (manifest === undefined) {
        console.error(`host-mcp-manager: ${agentId} 选择了未知服务器 ${entry.id}，已跳过`)
        continue
      }
      desired.push(resolveServer(manifest, entry.overrides, process.env))
    }
    await mounter.reconcile(agentId, agent.ctx, desired)
  }

  ctx.on?.('agent/pre-step', async (payload: PreStepPayload, next: () => unknown) => {
    try {
      await mountFor(payload.agent)
    } catch (error) {
      // A broken server or catalog row must never abort the step that mounts it.
      console.error(`host-mcp-manager: 挂载失败 agent=${payload.agent.id}: ${String(error)}`)
    }
    return next()
  })

  ctx.inject?.(['webServer', 'connection'], (scope) => {
    registerRoutes(scope, { db, ledgerPath, scanCatalog })
  })

  ctx.effect?.(() => () => {
    void mounter.disposeAll()
    db.close()
  }, 'host-mcp-manager: mounts')
}
