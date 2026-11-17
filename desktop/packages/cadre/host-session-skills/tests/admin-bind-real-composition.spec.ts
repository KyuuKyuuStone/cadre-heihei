/**
 * REAL-composition coverage for the skill-admin session binding lifecycle.
 *
 * A test-only cordis.yml boots the real session stack — JSONL persistence,
 * session query, typert, remote access, storage + sqlite domain, workspace
 * registry, session controller — next to the real webserver and the real
 * host-session-skills plugin. Binding assertions go through real HTTP and the
 * real `sessionController`, `sessionQuery`, `sessionPersistence`, and
 * `workspaceRegistry` services, plus the real audit files on disk. Test
 * stubs stay at externals the bind flow never reaches (model selection,
 * upload resolvers) and at the transport admission seam (`connection`); the
 * AdminSessionPort, sessions, workspace, storage, persistence, and webserver
 * are all real.
 * @module
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentPresetRegistryModule from '@deepseek-ai/dsh-agent-preset-registry'
import * as AgentPresetModule from '@deepseek-ai/dsh-agent-preset'
import * as JsonlPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as TypertRegistryModule from '@deepseek-ai/dsh-typert-registry'
import * as SessionQueryModule from '@deepseek-ai/dsh-session-query'
import * as RemoteAccessModule from '@deepseek-ai/dsh-api-remote-access'
import * as StorageModule from '@deepseek-ai/dsh-storage'
import * as StorageSqliteModule from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomainModule from '@deepseek-ai/dsh-storage-domain'
import * as WorkspaceModule from '@deepseek-ai/dsh-workspace'
import * as SessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import * as AttachmentLocalModule from '@deepseek-ai/dsh-attachment-local'
import * as WebServerModule from '@deepseek-ai/dsh-host-webserver'
import * as HostSessionSkillsModule from '../src/index.ts'
import {
  bootComposition, makeCompositionPaths, postJson, removeCompositionPaths, seedLedger,
  serviceOf, snapshotTree, waitForService, writeSkillPack, type CompositionPaths, type LedgerSeedRow,
} from './real-composition-host.ts'
import type { Context } from '@deepseek-ai/cordis'

const SEED: readonly LedgerSeedRow[] = [
  { projectId: 'p1', sessionId: 's-sup', role: 'supervisor' },
  { projectId: 'p1', sessionId: 'w-worker', role: 'worker' },
]

/** Controller session summary fields the assertions read. */
interface ListedSession {
  readonly sessionId: string
  readonly projections?: { readonly values?: Readonly<Record<string, unknown>> }
}

function hostServices(): { name: string; apply: (ctx: Context) => void } {
  return {
    name: 'test:host-services',
    apply(ctx: Context): void {
      // The Loader does not await async row applies, so the pieces the skills
      // plugin's own registration depends on are provided synchronously here;
      // the session-stack mounts run detached and the tests wait for them.
      ctx.provide('connection', { admit: () => undefined })
      ctx.provide('agentDefaultModel', {
        currentSelection: async () => undefined,
        saveSelection: async () => undefined,
      })
      ctx.provide('fileUploads', { registerAgentResolver: () => () => undefined })
      void (async (): Promise<void> => {
        await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
        await mountAgentLoopTestHarness(ctx)
      })()
    },
  }
}

function bindModules(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ['test:host-services', hostServices()],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistenceModule],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistryModule],
    ['@deepseek-ai/dsh-agent-preset-registry', AgentPresetRegistryModule],
    ['@deepseek-ai/dsh-agent-preset', AgentPresetModule],
    ['@deepseek-ai/dsh-session-query', SessionQueryModule],
    ['@deepseek-ai/dsh-api-remote-access', RemoteAccessModule],
    ['@deepseek-ai/dsh-storage', StorageModule],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqliteModule],
    ['@deepseek-ai/dsh-storage-domain', StorageDomainModule],
    ['@deepseek-ai/dsh-workspace', WorkspaceModule],
    ['@deepseek-ai/dsh-attachment-local', AttachmentLocalModule],
    ['@deepseek-ai/dsh-api-session-controller', SessionControllerModule],
    ['@deepseek-ai/dsh-host-webserver', WebServerModule],
    ['@deepseek-ai/dsh-host-session-skills', HostSessionSkillsModule],
  ])
}

function bindRows(options: {
  ledgerPath: string
  skillsDir: string
  builtinDir: string
  auditDir: string
  persistenceRoot: string
  storagePath: string
  dshHome: string
}): string[] {
  return [
    "- name: 'test:host-services'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: '${options.persistenceRoot}'`,
    "    compression: 'none'",
    "- name: '@deepseek-ai/dsh-typert-registry'",
    "- name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    "    default: 'cadre-skill-admin'",
    "- name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    "    id: 'cadre-skill-admin'",
    '    name: 技能管理员',
    '    description: 技能搜索、检查、预览与安装对话。',
    '    order: 90',
    '    plugins: []',
    "- name: '@deepseek-ai/dsh-session-query'",
    "- name: '@deepseek-ai/dsh-api-remote-access'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-sqlite'",
    '  config:',
    `    path: '${options.storagePath}'`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    "    backend: 'sqlite'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-attachment-local'",
    '  config:',
    `    dshHome: '${options.dshHome}'`,
    "- name: '@deepseek-ai/dsh-api-session-controller'",
    '  config:',
    '    nativeOpen: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-session-skills'",
    '  config:',
    `    ledgerPath: '${options.ledgerPath}'`,
    `    skillsDir: '${options.skillsDir}'`,
    `    builtinDir: '${options.builtinDir}'`,
    `    skillAdminAuditDir: '${options.auditDir}'`,
  ]
}

async function bindOrigin(context: Context): Promise<string> {
  return serviceOf<{ getOrigin(): string }>(context, 'webServer').getOrigin()
}

/** Bind composition rows against the shared ledger, audit dir, and skill dirs. */
function bindRowsFor(persistenceRoot: string, storagePath: string): string[] {
  return bindRows({
    ledgerPath: paths.ledgerPath, skillsDir: paths.skillsDir, builtinDir: paths.builtinDir,
    auditDir: paths.auditDir, persistenceRoot, storagePath, dshHome: paths.root,
  })
}

/** Wait for the session stack the bind assertions read; the detached testkit mounts land asynchronously. */
async function awaitAdminStack(context: Context): Promise<void> {
  await waitForService(context, 'sessionProjections')
  await waitForService(context, 'sessionController')
  await waitForService(context, 'sessionQuery')
  await waitForService(context, 'agentPresets')
  const presets = serviceOf<{ resolve(id: string): Promise<{ id: string }> }>(context, 'agentPresets')
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      await presets.resolve('cadre-skill-admin')
      return
    } catch {
      if (Date.now() > deadline) throw new Error('cadre-skill-admin preset did not register in the preset registry')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

const BIND = '/cadre/skills/admin/bind-session'

let paths: CompositionPaths
let context: Context | undefined
let homeRoot: string

beforeEach(async () => {
  paths = await makeCompositionPaths('dsh-skill-bind-real-')
  homeRoot = join(paths.root, 'home')
  await mkdir(homeRoot, { recursive: true })
  await writeSkillPack(paths.skillsDir, { id: 'pack-alpha', name: '技能包甲', description: '真实组合验证用技能包甲' })
  // Redirect the admin workspace root that `bindSession` derives from `homedir()`.
  vi.stubEnv('USERPROFILE', homeRoot)
  vi.stubEnv('HOME', homeRoot)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  await removeCompositionPaths(paths.root)
})

test('bind creates one real admin session and reuses it for the same skill key', async () => {
  seedLedger(paths.ledgerPath, SEED)
  context = await bootComposition({
    root: join(paths.root, 'boot'),
    rows: bindRowsFor(join(paths.root, 'sessions'), join(paths.root, 'cadre.sqlite')),
    modules: bindModules(),
  })
  await awaitAdminStack(context)
  const origin = await bindOrigin(context)

  const first = await postJson(origin, BIND, { projectId: 'p1', actorSessionId: 's-sup', skillId: 'skill-alpha', skillName: '技能甲' })
  expect(first.status).toBe(200)
  expect(first.ok).toBe(true)
  const sessionId = (first.result as { sessionId: string }).sessionId
  expect(typeof sessionId).toBe('string')

  const controller = serviceOf<{ list(request: Record<string, never>): Promise<{ items: readonly ListedSession[] }> }>(context, 'sessionController')
  const listed = await controller.list({})
  const bound = listed.items.find(item => item.sessionId === sessionId)
  expect(bound).toBeDefined()
  expect(bound?.projections?.values?.agentPreset).toBe('cadre-skill-admin')

  const sessionQuery = serviceOf<{ listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string; cwd?: string } }>> }>(context, 'sessionQuery')
  const records = await sessionQuery.listSessions()
  expect(records).toHaveLength(1)
  const [record] = records
  if (record === undefined) throw new Error('sessionQuery listed no sessions after bind')
  expect(record.header.cwd).toBe(join(homeRoot, '.dsh', 'cadre-skill-admin', 'workspace'))

  const skillMap = JSON.parse(await readFile(join(paths.auditDir, 'skill-sessions.json'), 'utf8')) as Record<string, Record<string, { sessionId: string; updatedAt: string }>>
  expect(skillMap['p1']?.['skill-alpha']?.sessionId).toBe(sessionId)

  const second = await postJson(origin, BIND, { projectId: 'p1', actorSessionId: 's-sup', skillId: 'skill-alpha', skillName: '技能甲' })
  expect(second.status).toBe(200)
  expect((second.result as { sessionId: string }).sessionId).toBe(sessionId)
  expect(await sessionQuery.listSessions()).toHaveLength(1)
})

test('rebinds a skill whose bound session the new Host run does not list, keeping the earlier run data', async () => {
  seedLedger(paths.ledgerPath, SEED)
  const run1Persistence = join(paths.root, 'sessions-run1')
  const context1 = await bootComposition({
    root: join(paths.root, 'boot-run1'),
    rows: bindRowsFor(run1Persistence, join(paths.root, 'cadre-run1.sqlite')),
    modules: bindModules(),
  })
  await awaitAdminStack(context1)
  const run1Origin = await bindOrigin(context1)
  const made = await postJson(run1Origin, BIND, { projectId: 'p1', actorSessionId: 's-sup', skillId: 'skill-beta', skillName: '技能乙' })
  expect(made.status).toBe(200)
  const sessionIdA = (made.result as { sessionId: string }).sessionId
  const skillMapRun1 = JSON.parse(await readFile(join(paths.auditDir, 'skill-sessions.json'), 'utf8')) as Record<string, Record<string, { sessionId: string; updatedAt: string }>>
  expect(skillMapRun1['p1']?.['skill-beta']?.sessionId).toBe(sessionIdA)
  // A bind-only session records no events, and the JSONL backend materializes
  // the log on the first append or flush, leaving no artifact before that. Drive
  // the production durability entry — the same `sessions.flush` the session
  // checkpoint policy invokes at turn boundaries — to publish the run's session
  // record, then pin its paths and exact bytes for the rebind boundary.
  const agents1 = serviceOf<{ get(id: string): { session: { id: string } } | undefined }>(context1, 'agents')
  const sessions1 = serviceOf<{ flush(session: { id: string }): Promise<boolean> }>(context1, 'sessions')
  const agentA = agents1.get(sessionIdA)
  if (agentA === undefined) throw new Error('run1 agent is not live after bind')
  await expect(sessions1.flush(agentA.session)).resolves.toBe(true)
  const run1Tree = await snapshotTree(run1Persistence)
  expect(run1Tree.length).toBeGreaterThan(0)
  expect(run1Tree.some(entry => entry.path.endsWith('.jsonl'))).toBe(true)
  expect(run1Tree.some(entry => entry.bytes.includes(sessionIdA))).toBe(true)
  await context1.fiber.dispose()
  // Snapshot after dispose: the first run's final on-disk state.
  const run1Sqlite = join(paths.root, 'cadre-run1.sqlite')
  const run1SqliteBytes = await readFile(run1Sqlite)

  // Second Host run: same ledger and audit dir, fresh persistence root — the
  // earlier run's bound session is not listed by this run's controller.
  const run2Persistence = join(paths.root, 'sessions-run2')
  const context2 = await bootComposition({
    root: join(paths.root, 'boot-run2'),
    rows: bindRowsFor(run2Persistence, join(paths.root, 'cadre-run2.sqlite')),
    modules: bindModules(),
  })
  context = context2
  await awaitAdminStack(context2)
  const run2Origin = await bindOrigin(context2)

  const rebound = await postJson(run2Origin, BIND, { projectId: 'p1', actorSessionId: 's-sup', skillId: 'skill-beta', skillName: '技能乙' })
  expect(rebound.status).toBe(200)
  const sessionIdB = (rebound.result as { sessionId: string }).sessionId
  expect(sessionIdB).not.toBe(sessionIdA)

  const controller2 = serviceOf<{ list(request: Record<string, never>): Promise<{ items: readonly ListedSession[] }> }>(context2, 'sessionController')
  const items = (await controller2.list({})).items
  expect(items.map(item => item.sessionId)).not.toContain(sessionIdA)
  expect(items.find(item => item.sessionId === sessionIdB)?.projections?.values?.agentPreset).toBe('cadre-skill-admin')

  const sessionQuery2 = serviceOf<{ listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string } }>> }>(context2, 'sessionQuery')
  expect(await sessionQuery2.listSessions()).toHaveLength(1)

  // The earlier Host run's session data survives untouched: its JSONL records
  // keep their exact paths and bytes, and its sqlite store keeps its bytes,
  // while the second run writes to its own persistence root and store.
  expect(await snapshotTree(run1Persistence)).toEqual(run1Tree)
  expect(await readFile(run1Sqlite)).toEqual(run1SqliteBytes)

  const skillMap = JSON.parse(await readFile(join(paths.auditDir, 'skill-sessions.json'), 'utf8')) as Record<string, Record<string, { sessionId: string; updatedAt: string }>>
  expect(skillMap['p1']?.['skill-beta']?.sessionId).toBe(sessionIdB)
  // sessions.json maps sessionId → projectId; the stale bind replaced the old
  // session's entry with the new session's.
  const projectMap = JSON.parse(await readFile(join(paths.auditDir, 'sessions.json'), 'utf8')) as Record<string, string>
  expect(projectMap[sessionIdB]).toBe('p1')
  expect(projectMap[sessionIdA]).toBeUndefined()
})

test('a real session-list failure answers HTTP 503, keeps the binding, and recovers', async () => {
  seedLedger(paths.ledgerPath, SEED)
  context = await bootComposition({
    root: join(paths.root, 'boot'),
    rows: bindRowsFor(join(paths.root, 'sessions'), join(paths.root, 'cadre.sqlite')),
    modules: bindModules(),
  })
  await awaitAdminStack(context)
  const origin = await bindOrigin(context)
  const bindInput = { projectId: 'p1', actorSessionId: 's-sup', skillId: 'skill-gamma', skillName: '技能丙' }

  const made = await postJson(origin, BIND, bindInput)
  expect(made.status).toBe(200)
  const sessionId = (made.result as { sessionId: string }).sessionId

  const persistence = serviceOf<{ list(signal?: AbortSignal): Promise<unknown> }>(context, 'sessionPersistence')
  const listSpy = vi.spyOn(persistence, 'list').mockRejectedValueOnce(new Error('模拟存储介质故障'))
  try {
    const failed = await postJson(origin, BIND, bindInput)
    expect(failed.status).toBe(503)
    expect(failed.code).toBe('SKILL_BIND_LOOKUP_FAILED')
    expect(failed.message).toContain('未创建新会话')
  } finally {
    listSpy.mockRestore()
  }

  const sessionQuery = serviceOf<{ listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string } }>> }>(context, 'sessionQuery')
  expect(await sessionQuery.listSessions()).toHaveLength(1)
  const skillMap = JSON.parse(await readFile(join(paths.auditDir, 'skill-sessions.json'), 'utf8')) as Record<string, Record<string, { sessionId: string; updatedAt: string }>>
  expect(skillMap['p1']?.['skill-gamma']?.sessionId).toBe(sessionId)

  const recovered = await postJson(origin, BIND, bindInput)
  expect(recovered.status).toBe(200)
  expect((recovered.result as { sessionId: string }).sessionId).toBe(sessionId)
})

test('the real webserver answers a non-POST bind-session call with 405', async () => {
  seedLedger(paths.ledgerPath, SEED)
  context = await bootComposition({
    root: join(paths.root, 'boot'),
    rows: bindRowsFor(join(paths.root, 'sessions'), join(paths.root, 'cadre.sqlite')),
    modules: bindModules(),
  })
  const origin = await bindOrigin(context)
  const response = await fetch(`${origin}${BIND}`, { method: 'GET' })
  expect(response.status).toBe(405)
})

