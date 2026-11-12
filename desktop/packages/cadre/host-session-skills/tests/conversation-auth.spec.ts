/**
 * DESIGN §3 authorization matrix, executed through the real conversational executor
 * over a real SkillApi and a real roster ledger. Every rejection asserts the stable
 * code plus its Chinese, actionable remediation — the tool never decides authority
 * by presence in the prompt.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuditLog, createLedgerResolver, createSessionPort, SkillConversationExecutor, type SkillToolResult } from '../src/conversation.ts'
import { createSkillApi } from '../src/ipc.ts'

const roots: string[] = []
const handles: { close(): void }[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch {
        // SQLite may hold the ledger briefly on Windows; the directory stays under TEMP.
      }
    }
  }
})

const CHINESE = /[\u4e00-\u9fa5]/
const REMOTE_URL = 'https://raw.githubusercontent.com/o/r/main/pack/'

interface Host {
  readonly executor: SkillConversationExecutor
  readonly root: string
  readonly auditFile: string
}

function host(options: {
  readonly remoteLicense?: string | undefined
} = {}): Host {
  const root = mkdtempSync(join(tmpdir(), 'cadre-conversation-auth-'))
  roots.push(root)
  const ledgerPath = join(root, 'ledger.sqlite')
  const skillsDir = join(root, 'installed')
  const builtinDir = join(root, 'builtin')
  const auditDir = join(root, 'audit')
  for (const dir of [skillsDir, builtinDir, auditDir]) mkdirSync(dir, { recursive: true })
  const seed = new DatabaseSync(ledgerPath)
  seed.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  seed.exec(`CREATE TABLE projects (project_id TEXT NOT NULL PRIMARY KEY)`)
  seed.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
    VALUES ('p1', 's-sup', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p1', 's-worker', 'worker', 'available', '[]', 'now', 'now'),
           ('p1', 's-departed', 'worker', 'departed', '[]', 'now', 'now'),
           ('p2', 's-other', 'worker', 'available', '[]', 'now', 'now')`).run()
  seed.prepare(`INSERT INTO projects (project_id) VALUES ('p1'), ('p2')`).run()
  const builtinPack = join(builtinDir, 'builtin-pack')
  mkdirSync(builtinPack, { recursive: true })
  writeFileSync(join(builtinPack, 'manifest.json'), JSON.stringify({
    id: 'builtin-pack', name: 'Builtin Pack', description: 'built in', roles: ['worker'],
    tokenEstimate: 10, tools: [], source: 'builtin', license: 'MIT', author: 'cadre',
  }))
  writeFileSync(join(builtinPack, 'SKILL.md'), '# Builtin\n')
  const writable = new DatabaseSync(ledgerPath)
  handles.push(writable)
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = String(input)
    return raw.endsWith('manifest.json')
      ? new Response(JSON.stringify({
        id: 'remote-pack', name: 'Remote Pack', description: 'remote',
        roles: ['worker'], tokenEstimate: 10, tools: [], source: 'github:o/r',
        license: options.remoteLicense ?? 'MIT',
        ...(options.remoteLicense === undefined ? {} : { author: 'cadre' }),
      }), { status: 200 })
      : new Response('# Remote\n', { status: 200 })
  }
  const api = createSkillApi({
    db: writable,
    ledgerPath,
    skillsDir,
    builtinDir,
    auditDir,
    fetch,
  })
  const resolver = createLedgerResolver(writable)
  const auditFile = join(auditDir, 'audit.jsonl')
  const port = createSessionPort({ api, resolver, skillsDir, builtinDir, audit: createAuditLog(auditFile) })
  return { executor: new SkillConversationExecutor({ port }), root, auditFile }
}

function failed(result: SkillToolResult<object>): { code: string; remediation: string; message: string } {
  if (result.ok) throw new Error('expected a rejection envelope')
  expect(result.remediation).toMatch(CHINESE)
  console.log(`auth rejection: code=${result.code} message=${result.message} remediation=${result.remediation}`)
  return result
}

const createInput = {
  id: 'daily-summary', name: 'Daily Summary', description: 'Summarize daily work',
  content: '# Daily Summary\n\nSummarize the day.\n', roles: ['worker'], tools: ['read'], tokenEstimate: 1200,
}

describe('DESIGN §3 authorization matrix through the executor', () => {
  it('denies cross-project, departed, and unknown-project callers with Chinese remediation', async () => {
    const { executor } = host()
    expect(failed(await executor.catalog('s-worker', undefined, 'p2')).code).toBe('SKILL_FORBIDDEN')
    expect(failed(await executor.catalog('s-departed', undefined)).code).toBe('SKILL_FORBIDDEN')
    expect(failed(await executor.catalog('s-off-roster', undefined)).code).toBe('SKILL_PROJECT_REQUIRED')
    expect(failed(await executor.install('s-worker', { url: REMOTE_URL }, 'p2')).code).toBe('SKILL_FORBIDDEN')
    expect((await executor.catalog('s-worker', undefined)).ok).toBe(true)
    expect((await executor.catalog('s-sup', undefined)).ok).toBe(true)
  })

  it('keeps warning installs behind supervisor confirmation for workers and employees', async () => {
    const { executor } = host()
    expect(failed(await executor.install('s-worker', { url: REMOTE_URL })).code).toBe('SKILL_CONFIRM_REQUIRED')
    expect(failed(await executor.install('s-worker', { url: REMOTE_URL, confirm: true })).code).toBe('SKILL_CONFIRM_REQUIRED')
    const pending = await executor.install('s-sup', { url: REMOTE_URL })
    expect(pending.ok).toBe(true)
    if (!pending.ok) throw new Error('unreachable')
    expect(pending.requiresConfirmation).toBe(true)
    expect(pending.installed).toBe(false)
    const confirmed = await executor.install('s-sup', { url: REMOTE_URL, confirm: true })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) throw new Error('unreachable')
    expect(confirmed.installed).toBe(true)
  })

  it('allows new ids for everyone, refuses worker overwrite, allows supervisor overwrite with both flags', async () => {
    const { executor } = host()
    const created = await executor.create('s-worker', createInput)
    expect(created.ok).toBe(true)
    expect(failed(await executor.create('s-worker', createInput)).code).toBe('SKILL_EXISTS')
    expect(failed(await executor.create('s-worker', { ...createInput, overwrite: true, confirm: true })).code).toBe('SKILL_FORBIDDEN')
    expect(failed(await executor.create('s-sup', { ...createInput, overwrite: true })).code).toBe('SKILL_INVALID')
    const overwritten = await executor.create('s-sup', { ...createInput, overwrite: true, confirm: true })
    expect(overwritten.ok).toBe(true)
  })

  it('scopes audit to the actor for members and to the project for supervisors', async () => {
    const { executor, auditFile } = host()
    const { appendFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(auditFile, '..'), { recursive: true })
    const row = (actorSessionId: string, projectId: string, packId: string): string => JSON.stringify({
      id: `audit-${packId}`, time: '2026-11-11T00:00:00.000Z', kind: 'create', actorSessionId, projectId, packId,
      result: 'created', warnings: [],
    })
    appendFileSync(auditFile, `${row('s-worker', 'p1', 'a')}\n${row('s-sup', 'p1', 'b')}\n${row('s-other', 'p2', 'c')}\n`)
    const workerRows = await executor.audit('s-worker', 20)
    expect(workerRows.ok).toBe(true)
    if (!workerRows.ok) throw new Error('unreachable')
    expect(workerRows.items.map(item => item.packId)).toEqual(['a'])
    const supervisorRows = await executor.audit('s-sup', 50)
    if (!supervisorRows.ok) throw new Error('unreachable')
    expect(supervisorRows.items.map(item => item.packId).sort()).toEqual(['a', 'b'])
    expect(failed(await executor.audit('s-other', 5, 'p1')).code).toBe('SKILL_FORBIDDEN')
  })

  it('generates read-only plans and keeps builtin or unknown targets rejected', async () => {
    const { executor } = host()
    const plan = await executor.plan('s-worker', { kind: 'install', url: REMOTE_URL })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('unreachable')
    expect(plan.planId).toMatch(/[0-9a-f-]{36}/)
    expect(plan.confirmToken).toMatch(/[0-9a-f-]{36}/)
    expect(plan.actions).toContain('write-pack')
    expect(failed(await executor.plan('s-worker', { kind: 'install', url: 'http://example.com/pack' })).code).toBe('SKILL_INVALID')
    expect(failed(await executor.plan('s-worker', { kind: 'update', packId: 'builtin-pack' })).code).toBe('SKILL_BUILTIN_READONLY')
    expect(failed(await executor.plan('s-worker', { kind: 'remove', packId: 'missing-pack' })).code).toBe('SKILL_NOT_FOUND')
    const supervisorPlan = await executor.plan('s-sup', { kind: 'install', url: REMOTE_URL })
    expect(supervisorPlan.ok).toBe(true)
  })
})
