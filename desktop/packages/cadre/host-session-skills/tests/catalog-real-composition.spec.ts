/**
 * REAL-composition coverage for the skill catalog HTTP surface.
 *
 * A test-only cordis.yml boots the real host-session-skills main plugin next
 * to the real webserver over the Loader. The SQLite ledger and the on-disk
 * skill packs are the real backing stores, and every assertion goes through
 * real HTTP against the real listening server. The only test-provided piece
 * is the transport admission service (`connection`) — no AdminSessionPort,
 * ledger, catalog, or workspace mock exists on this surface.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import * as WebServerModule from '@deepseek-ai/dsh-host-webserver'
import * as HostSessionSkillsModule from '../src/index.ts'
import {
  bootComposition, makeCompositionPaths, postJson, removeCompositionPaths, seedLedger,
  serviceOf, writeSkillPack, type CompositionPaths, type LedgerSeedRow,
} from './real-composition-host.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Catalog entry projection the routes return. */
interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly origin: string
  readonly selected: boolean
  readonly source: string
  readonly license: string
}

// `s-off` is deliberately absent: an off-roster session is rostered nowhere.
const SEED: readonly LedgerSeedRow[] = [
  { projectId: 'p1', sessionId: 's-sup', role: 'supervisor' },
  { projectId: 'p1', sessionId: 'w-worker', role: 'worker' },
  { projectId: 'p1', sessionId: 's-dep', role: 'supervisor', state: 'departed' },
  { projectId: 'p2', sessionId: 's-other', role: 'worker' },
]

function hostServices(): { name: string; apply: (ctx: Context) => void } {
  return {
    name: 'test:host-services',
    apply(ctx: Context): void {
      ctx.provide('connection', {
        admit: () => undefined,
      })
    },
  }
}

let paths: CompositionPaths
let context: Context | undefined
let origin: string

beforeEach(async () => {
  paths = await makeCompositionPaths('dsh-skill-catalog-real-')
  seedLedger(paths.ledgerPath, SEED)
  await writeSkillPack(paths.skillsDir, { id: 'pack-alpha', name: '技能包甲', description: '真实组合验证用技能包甲' })
  await writeSkillPack(paths.builtinDir, { id: 'pack-beta', name: '技能包乙', description: '真实组合验证用技能包乙' })
  context = await bootComposition({
    root: paths.root,
    rows: [
      "- name: 'test:host-services'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-host-session-skills'",
      '  config:',
      `    ledgerPath: '${paths.ledgerPath}'`,
      `    skillsDir: '${paths.skillsDir}'`,
      `    builtinDir: '${paths.builtinDir}'`,
      `    skillAdminAuditDir: '${paths.auditDir}'`,
    ],
    modules: new Map<string, unknown>([
      ['test:host-services', hostServices()],
      ['@deepseek-ai/dsh-host-webserver', WebServerModule],
      ['@deepseek-ai/dsh-host-session-skills', HostSessionSkillsModule],
    ]),
  })
  origin = serviceOf<{ getOrigin(): string }>(context, 'webServer').getOrigin()
  console.log('[real-composition:catalog] booted via Loader+Include, real webserver origin:', origin)
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await removeCompositionPaths(paths.root)
})

test('supervisor reads the real on-disk catalog over real HTTP', async () => {
  const reply = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 's-sup' })
  expect(reply.status).toBe(200)
  expect(reply.ok).toBe(true)
  const entries = reply.result as CatalogEntry[]
  expect(entries.map(entry => entry.id).sort()).toEqual(['pack-alpha', 'pack-beta'])
  const alpha = entries.find(entry => entry.id === 'pack-alpha')!
  expect(alpha.name).toBe('技能包甲')
  expect(alpha.origin).toBe('installed')
  expect(alpha.source).toBe('test-suite')
  expect(alpha.license).toBe('MIT')
  expect(alpha.selected).toBe(false)
  const beta = entries.find(entry => entry.id === 'pack-beta')!
  expect(beta.origin).toBe('builtin')
})

test('a session rostered nowhere reads the catalog and echoes a set without any durable write', async () => {
  const listReply = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 's-off' })
  expect(listReply.status).toBe(200)
  const entries = listReply.result as CatalogEntry[]
  expect(entries).toHaveLength(2)
  expect(entries.every(entry => entry.selected === false)).toBe(true)

  const getReply = await postJson(origin, '/cadre/skills/get', { projectId: 'p1', actorSessionId: 's-off', targetSessionId: 's-off' })
  expect(getReply.status).toBe(200)
  expect(getReply.result).toEqual({ skills: [] })

  const setReply = await postJson(origin, '/cadre/skills/set', { projectId: 'p1', actorSessionId: 's-off', targetSessionId: 's-off', skills: ['pack-alpha'] })
  expect(setReply.status).toBe(200)
  expect(setReply.result).toEqual({ skills: ['pack-alpha'] })

  const verify = new DatabaseSync(paths.ledgerPath, { readOnly: true })
  try {
    expect(verify.prepare('SELECT skills_json FROM members WHERE project_id = ? AND session_id = ?')
      .get('p1', 's-off')).toBeUndefined()
  } finally {
    verify.close()
  }

  const again = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 's-off' })
  expect((again.result as CatalogEntry[]).every(entry => entry.selected === false)).toBe(true)
})

test('roster boundaries reject departed, cross-project, and unauthorized cross-member access', async () => {
  const departed = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 's-dep' })
  expect(departed.status).toBe(403)
  expect(departed.code).toBe('SKILL_FORBIDDEN')
  expect(departed.message).toContain('会话已退出')

  const crossProject = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 's-other' })
  expect(crossProject.status).toBe(403)
  expect(crossProject.message).toContain('属于其他项目')

  const workerViewsOther = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 's-sup' })
  expect(workerViewsOther.status).toBe(403)
  expect(workerViewsOther.message).toContain('只有 supervisor 可以查看其他成员的技能')

  const workerSetsOther = await postJson(origin, '/cadre/skills/set', { projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 's-sup', skills: [] })
  expect(workerSetsOther.status).toBe(403)
  expect(workerSetsOther.message).toContain('只有 supervisor 可以修改其他成员的技能')
})

test('an unproven project id stays readable through the catalog but stays unwritable', async () => {
  const catalog = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p-none', actorSessionId: 's-off' })
  expect(catalog.status).toBe(200)
  expect((catalog.result as CatalogEntry[]).every(entry => entry.selected === false)).toBe(true)

  const set = await postJson(origin, '/cadre/skills/set', { projectId: 'p-none', actorSessionId: 's-off', targetSessionId: 's-off', skills: [] })
  expect(set.status).toBe(403)
  expect(set.message).toContain('项目不存在：p-none')
})

test('supervisor reads and writes another member through the real ledger', async () => {
  const view = await postJson(origin, '/cadre/skills/get', { projectId: 'p1', actorSessionId: 's-sup', targetSessionId: 'w-worker' })
  expect(view.status).toBe(200)
  expect(view.result).toEqual({ skills: [] })

  const write = await postJson(origin, '/cadre/skills/set', { projectId: 'p1', actorSessionId: 's-sup', targetSessionId: 'w-worker', skills: ['pack-alpha'] })
  expect(write.status).toBe(200)
  expect(write.result).toEqual({ skills: ['pack-alpha'] })

  const verify = new DatabaseSync(paths.ledgerPath, { readOnly: true })
  try {
    const row = verify.prepare('SELECT skills_json FROM members WHERE project_id = ? AND session_id = ?')
      .get('p1', 'w-worker') as { skills_json: string }
    expect(JSON.parse(row.skills_json)).toEqual(['pack-alpha'])
  } finally {
    verify.close()
  }

  const catalog = await postJson(origin, '/cadre/skills/catalog', { projectId: 'p1', actorSessionId: 'w-worker' })
  expect(catalog.status).toBe(200)
  const selected = (catalog.result as CatalogEntry[]).find(entry => entry.id === 'pack-alpha')!
  expect(selected.selected).toBe(true)
})

test('unknown pack ids are rejected and preview requires a supervisor', async () => {
  const unknownPack = await postJson(origin, '/cadre/skills/set', { projectId: 'p1', actorSessionId: 's-sup', targetSessionId: 's-sup', skills: ['ghost-pack'] })
  expect(unknownPack.status).toBe(400)
  expect(unknownPack.code).toBe('SKILL_NOT_FOUND')
  expect(unknownPack.message).toContain('未知技能包：ghost-pack')

  const workerPreview = await postJson(origin, '/cadre/skills/preview', { projectId: 'p1', actorSessionId: 'w-worker', packId: 'pack-alpha' })
  expect(workerPreview.status).toBe(403)

  const supervisorPreview = await postJson(origin, '/cadre/skills/preview', { projectId: 'p1', actorSessionId: 's-sup', packId: 'pack-alpha' })
  expect(supervisorPreview.status).toBe(200)
  expect((supervisorPreview.result as { content: string }).content).toContain('# 技能包甲')
})

test('the real webserver answers a non-POST catalog call with 405', async () => {
  const response = await fetch(`${origin}/cadre/skills/catalog`, { method: 'GET' })
  expect(response.status).toBe(405)
})
