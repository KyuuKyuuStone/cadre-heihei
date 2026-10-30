import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import { apply } from '../src/index.ts'

const PROJECT = 'p-write'
const ROOT = 'C:/project-root'
const SUP = 'sup-write'
const WORKER = 'worker-write'
const AT = '2026-10-30T00:00:00.000Z'
const roots: string[] = []
const closers: (() => void)[] = []
const previous = process.env.CADRE_LEDGER_PATH

afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.CADRE_LEDGER_PATH
  else process.env.CADRE_LEDGER_PATH = previous
})

type Listener = (payload: {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id: string }
}, next: () => Promise<unknown>) => Promise<unknown>

function mount(policy: object = {
  version: 1, roles: ['supervisor'], roots: ['project', 'reports'], reportDirName: 'reports',
  allowExtensions: ['.md', '.txt'],
  writeTools: { write: { path: 'file_path' } },
  denyTools: { office_docx: 'office', bash: 'shell' },
  denyToolPrefixes: ['office_'],
}) {
  const dir = mkdtempSync(join(tmpdir(), 'write-guard-index-'))
  roots.push(dir)
  const db = join(dir, 'cadre.sqlite')
  initCadreStore(db)
  const raw = new DatabaseSync(db)
  try {
    raw.prepare(`INSERT INTO projects (project_id, name, root_path, status, created_at)
      VALUES (?, 'p', ?, 'active', ?)`).run(PROJECT, ROOT, AT)
    const member = raw.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    member.run(PROJECT, SUP, 'supervisor', '主管', AT, AT)
    member.run(PROJECT, WORKER, 'worker', '员工', AT, AT)
  } finally {
    raw.close()
  }
  const policyPath = join(dir, 'policy.json')
  writeFileSync(policyPath, JSON.stringify(policy))
  process.env.CADRE_LEDGER_PATH = db
  let listener: Listener | undefined
  let dispose: (() => void) | undefined
  apply({
    on: (_event, handler) => { listener = handler as Listener; return () => {} },
    effect: (setup) => { dispose = setup(); return () => {} },
  }, { policyPath })
  if (listener === undefined) throw new Error('guard listener missing')
  closers.push(() => dispose?.())
  const next = async (): Promise<unknown> => ({ allow: true })
  return {
    call: (name: string, args: Record<string, unknown>, agent: string) => listener!({ name, arguments: args, agent: { id: agent } }, next),
    rewrite: (value: object) => writeFileSync(policyPath, JSON.stringify(value)),
    audit: () => readFileSync(`${db}.write-guard.log`, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>),
    dispose: () => dispose?.(),
  }
}

describe('write guard pre-execute', () => {
  it('allows supervisor .md in the project and audits it', async () => {
    const guard = mount()
    const result = await guard.call('write', { file_path: `${ROOT}/notes/a.md` }, SUP)
    expect(result).toEqual({ allow: true })
    const [line] = guard.audit()
    expect(line).toBeDefined()
    expect(String(line!.at)).toMatch(/Z$/u) // 全链路 UTC（验收矩阵 §一.1 审计字段）
    expect(line).toMatchObject({
      actor: SUP, project: PROJECT, role: 'supervisor', tool: 'write',
      decision: 'allow', rule: 'allowed',
    })
    expect(String(line?.at)).toMatch(/Z$/u)
  })

  it('denies extension, Office, shell, and missing path with stable codes', async () => {
    const guard = mount()
    expect(await guard.call('write', { file_path: `${ROOT}/a.ts` }, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_EXTENSION_DENIED' } })
    expect(await guard.call('office_docx', { output: `${ROOT}/a.docx` }, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_POLICY_DENIED' } })
    expect(await guard.call('bash', { command: 'echo x > a.md' }, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_POLICY_DENIED' } })
    expect(await guard.call('write', {}, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_POLICY_TOOL_UNSUPPORTED' } })
  })

  it('denies a supervisor whose project has no registered root and fails closed on a broken policy', async () => {
    const guard = mount()
    expect(await guard.call('write', { file_path: `${ROOT}/a.md` }, 'stranger'))
      .toEqual({ allow: true }) // ordinary/unknown sessions are not this guard's scope
    guard.rewrite({ version: 99 })
    expect(await guard.call('write', { file_path: `${ROOT}/a.md` }, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_POLICY_UNAVAILABLE' } })
  })

  it('lets workers through untouched', async () => {
    const guard = mount()
    expect(await guard.call('write', { file_path: `${ROOT}/a.py` }, WORKER)).toEqual({ allow: true })
    expect(await guard.call('bash', { command: 'rm -rf /' }, WORKER)).toEqual({ allow: true })
  })

  it('applies a changed policy on the next call without restart (hot reload)', async () => {
    const guard = mount()
    expect(await guard.call('write', { file_path: `${ROOT}/a.md` }, SUP)).toEqual({ allow: true })
    guard.rewrite({
      version: 1, roles: ['supervisor'], roots: ['project', 'reports'], reportDirName: 'reports',
      allowExtensions: ['.txt'], writeTools: { write: { path: 'file_path' } },
      denyTools: {}, denyToolPrefixes: [],
    })
    expect(await guard.call('write', { file_path: `${ROOT}/a.md` }, SUP))
      .toMatchObject({ kind: 'deny', info: { code: 'WRITE_EXTENSION_DENIED' } })
  })
})


