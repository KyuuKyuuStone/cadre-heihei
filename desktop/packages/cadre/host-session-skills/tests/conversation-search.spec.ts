/**
 * DESIGN §4 remote-search behavior: no provider reaches the network, every provider
 * failure degrades to local matches with the Chinese reason, and only an unreadable
 * local catalog becomes SKILL_SEARCH_UNAVAILABLE.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAuditLog, createLedgerResolver, createSessionPort, SkillConversationExecutor,
  type SearchResult, type SkillSearchProvider,
} from '../src/conversation.ts'
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

const DEGRADED = '远程搜索不可用，已返回本地结果；可稍后重试远程搜索'
const CHINESE = /[\u4e00-\u9fa5]/

interface Host {
  readonly sessionId: string
  readonly executor: (options?: { readonly search?: SkillSearchProvider; readonly searchTimeoutMs?: number }) => SkillConversationExecutor
  readonly fetch: ReturnType<typeof vi.fn>
}

function host(options: { readonly unreadableCatalog?: boolean } = {}): Host {
  const root = mkdtempSync(join(tmpdir(), 'cadre-conversation-search-'))
  roots.push(root)
  const ledgerPath = join(root, 'ledger.sqlite')
  const skillsDir = join(root, 'installed')
  if (options.unreadableCatalog === true) {
    writeFileSync(skillsDir, 'not a directory\n')
  } else {
    mkdirSync(skillsDir, { recursive: true })
    const pack = join(skillsDir, 'pdf-tools')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({
      id: 'pdf-tools', name: 'PDF Tools', description: 'Read and split PDFs', roles: ['worker'],
      tokenEstimate: 100, tools: ['read'], source: 'github:o/r', license: 'MIT', author: 'cadre',
    }))
    writeFileSync(join(pack, 'SKILL.md'), '# PDF Tools\n')
  }
  const seed = new DatabaseSync(ledgerPath)
  seed.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  seed.prepare(`INSERT INTO members (project_id, session_id, role, state, created_at, updated_at)
    VALUES ('p1', 's1', 'worker', 'available', 'now', 'now')`).run()
  seed.close()
  const db = new DatabaseSync(ledgerPath)
  handles.push(db)
  const fetch = vi.fn(async () => { throw new Error('search must not reach the network') })
  const api = createSkillApi({ db, ledgerPath, skillsDir, fetch })
  const port = createSessionPort({
    api,
    resolver: createLedgerResolver(db),
    skillsDir,
    audit: createAuditLog(join(root, 'audit.jsonl')),
  })
  return {
    sessionId: 's1',
    fetch,
    executor: (executorOptions = {}) => new SkillConversationExecutor({ port, ...executorOptions }),
  }
}

const hit: SearchResult = {
  packId: 'remote-pdf', name: 'Remote PDF', description: 'remote', sourceUrl: 'https://example.com/pdf', license: 'MIT',
}

describe('conversational search degradation', () => {
  it('returns local matches without any remote request when no provider is injected', async () => {
    const host0 = host()
    const result = await host0.executor().searchQuery(host0.sessionId, 'pdf')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source).toBe('local')
    expect(result.degraded).toBe(true)
    expect(result.message).toBe(DEGRADED)
    expect(result.items.map(item => item.packId)).toEqual(['pdf-tools'])
    expect(host0.fetch).not.toHaveBeenCalled()
    console.log(`search no-provider: fetch calls=0 source=${result.source} degraded=${String(result.degraded)} message=${result.message}`)
  })

  it('degrades on timeout, non-2xx, and malformed JSON with the same Chinese reason', async () => {
    const host0 = host()
    const hanging: SkillSearchProvider = {
      search: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    }
    const timedOut = await host0.executor({ search: hanging, searchTimeoutMs: 25 }).searchQuery(host0.sessionId, 'pdf')
    expect(timedOut.ok).toBe(true)
    if (!timedOut.ok) throw new Error('unreachable')
    expect(timedOut.degraded).toBe(true)
    expect(timedOut.message).toBe(DEGRADED)
    console.log(`search timeout: source=${timedOut.source} degraded=${String(timedOut.degraded)} message=${timedOut.message}`)

    const nonOk: SkillSearchProvider = { search: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }) } }
    const rejected = await host0.executor({ search: nonOk }).searchQuery(host0.sessionId, 'pdf')
    if (!rejected.ok) throw new Error('unreachable')
    expect(rejected.source).toBe('local')
    expect(rejected.message).toBe(DEGRADED)
    console.log(`search non-2xx: source=${rejected.source} degraded=${String(rejected.degraded)} message=${rejected.message}`)

    const malformed: SkillSearchProvider = { search: async () => { throw new SyntaxError('Unexpected token < in JSON') } }
    const broken = await host0.executor({ search: malformed }).searchQuery(host0.sessionId, 'pdf')
    if (!broken.ok) throw new Error('unreachable')
    expect(broken.items.map(item => item.packId)).toEqual(['pdf-tools'])
    expect(broken.message).toBe(DEGRADED)
    console.log(`search malformed-json: source=${broken.source} degraded=${String(broken.degraded)} message=${broken.message}`)
  })

  it('passes provider hits through when the remote search succeeds', async () => {
    const host0 = host()
    const remote: SkillSearchProvider = { search: async () => [hit] }
    const result = await host0.executor({ search: remote }).searchQuery(host0.sessionId, 'pdf', 3)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source).toBe('remote')
    expect(result.degraded).toBe(false)
    expect(result.items.map(item => item.packId)).toEqual(['remote-pdf'])
  })

  it('keeps an empty local result successful and only an unreadable catalog unavailable', async () => {
    const host0 = host()
    const empty = await host0.executor().searchQuery(host0.sessionId, 'no-such-skill')
    expect(empty.ok).toBe(true)
    if (!empty.ok) throw new Error('unreachable')
    expect(empty.items).toEqual([])
    expect(empty.degraded).toBe(true)

    const broken = host({ unreadableCatalog: true })
    const unavailable = await broken.executor().searchQuery(broken.sessionId, 'pdf')
    expect(unavailable.ok).toBe(false)
    if (unavailable.ok) throw new Error('unreachable')
    expect(unavailable.code).toBe('SKILL_SEARCH_UNAVAILABLE')
    expect(unavailable.message).toMatch(CHINESE)
    expect(unavailable.remediation).toMatch(CHINESE)
  })
})
