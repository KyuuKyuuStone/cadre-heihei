/**
 * Real Loader composition over durable JSONL Session logs: the ledger observes
 * committed `assistant/message` usage, persists ignorable records, and rebuilds
 * its totals after a process restart.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { createAssistantMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId, type PluginRecord, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenLedger from '../src/index.ts'

/** Provider buckets used by every fixture call. */
const USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 18,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 3,
}

/** Expected aggregate of one {@link USAGE} call. */
const ONE_CALL = {
  requests: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 3,
  billedTokens: 18,
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A booted composition sharing one temporary storage root. */
interface Composition {
  readonly ctx: Awaited<ReturnType<typeof boot>>
  readonly root: string
  readonly session: Session
}

/**
 * Boot the real Loader composition: Session store, JSONL persistence, the
 * projection registry, and this package's plugin.
 * @param root - storage root of the composition, reused across restarts.
 * @returns the booted context and one empty durable Session.
 */
async function composition(root?: string): Promise<Composition> {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'dsh-token-ledger-'))
  if (root === undefined) cleanups.push(async () => { await rm(storage, { recursive: true, force: true }) })
  const configPath = join(storage, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'storage', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(storage, 'sessions'), compression: 'none' } },
    { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'ledger', name: '@deepseek-ai/dsh-experimental-token-ledger' },
  ]))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-experimental-token-ledger', TokenLedger],
  ])
  const ctx = await boot('token-ledger-composition', configPath, [], (host) => {
    const loader: ModuleLoaderV2 = {
      version: 'v2', loadCache: new Map(),
      async import(specifier) {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture import ${specifier}`)
        return modules.get(specifier)
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    host.loader.internal = loader
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const session = ctx.sessions.create(SessionId(`ledger-fixture-${Date.now()}`), { meta: { cwd: storage } })
  await ctx.sessionPersistence.create(session.header)
  return { ctx, root: storage, session }
}

/** Next turn this process records for each Session id, across a restart. */
const nextTurn = new Map<string, number>()

/**
 * Commit one assistant settlement carrying provider usage, exactly as the agent
 * loop commits it: an open turn, an open step, then the assistant message.
 * @param session - the Session receiving the step.
 * @param usage - provider-reported buckets.
 * @param text - the assistant answer text.
 * @returns the committed assistant message event.
 */
function assistant(session: Session, usage: TokenUsage, text = 'fixture answer'): SessionEvent {
  const turn = (nextTurn.get(session.id) ?? 0) + 1
  nextTurn.set(session.id, turn)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const committed = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'fixture-provider', model: 'fixture-model' },
    }),
    stream: [],
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return committed
}

/**
 * Let the recorder's deferred append and the persistence write queue run.
 * @returns a promise settled after the next timer turn.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Read one stored Session's committed events.
 * @param ctx - the booted composition.
 * @param id - the Session to read.
 * @returns the stored events in commit order.
 */
async function storedEvents(ctx: Composition['ctx'], id: SessionId): Promise<readonly SessionEvent[]> {
  await using handle = await ctx.sessionPersistence.open(id, 'read')
  return (await handle.read()).events
}

/**
 * Select this package's committed records from a stored log. `pluginRecordOf`
 * yields a record only for an event marked ignorable, so this also observes the
 * envelope marker that keeps the record out of the model-visible surface.
 * @param events - stored Session events.
 * @returns the records this package owns, in commit order.
 */
function ledgerRecords(events: readonly SessionEvent[]): PluginRecord[] {
  return events.flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:token-ledger/usage' ? [record] : []
  })
}

describe('token ledger composition', () => {
  it('records committed usage as an ignorable plugin record and totals it', async () => {
    const { ctx, session } = await composition()
    const committed = assistant(session, USAGE)
    await settle()

    const report = ctx.tokenLedger.get(session)
    expect(report.sessionId).toBe(session.id)
    expect(report.totals).toEqual(ONE_CALL)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({
      sourceSeq: committed.seq,
      turn: 1,
      step: 1,
      provider: 'fixture-provider',
      model: 'fixture-model',
      usage: USAGE,
    })
    expect(ctx.tokenLedger.global()).toEqual({ sessions: 1, totals: ONE_CALL })

    await ctx.sessions.flush(session)
    const records = ledgerRecords(await storedEvents(ctx, session.id))
    expect(records).toHaveLength(1)
    expect(records[0]!.data).toEqual({
      sourceSeq: committed.seq,
      turn: 1,
      step: 1,
      provider: 'fixture-provider',
      model: 'fixture-model',
      usage: USAGE,
    })
    // The record stays outside the model-visible surface.
    expect(session.deriveMessages()).toHaveLength(1)
  })

  it('rebuilds per-Session totals from stored records after a restart', async () => {
    const first = await composition()
    const committed = assistant(first.session, USAGE)
    await settle()
    await first.ctx.sessions.flush(first.session)
    const id = first.session.id
    const header = first.session.header
    await first.ctx.fiber.dispose()

    const second = await composition(first.root)
    const events = await storedEvents(second.ctx, id)
    const resumed = second.ctx.sessions.create(id, { seed: events, meta: header })
    expect(second.ctx.tokenLedger.get(resumed).totals).toEqual(ONE_CALL)
    expect(second.ctx.tokenLedger.get(resumed).entries[0]!.sourceSeq).toBe(committed.seq)

    assistant(resumed, { inputTokens: 4, outputTokens: 1 })
    await settle()
    expect(second.ctx.tokenLedger.get(resumed).totals).toEqual({
      requests: 2,
      inputTokens: 14,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      billedTokens: 23,
    })
    expect(second.ctx.tokenLedger.global().sessions).toBe(1)
  })

  it('stops recording and unregisters its projection when its fiber unloads', async () => {
    const { ctx, session } = await composition()
    assistant(session, USAGE)
    await settle()

    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-experimental-token-ledger')
    if (entry?.fiber === undefined) throw new Error('expected the ledger Loader row to be active')
    await entry.fiber.dispose()
    expect(ctx.sessionProjections.stateOf(session, 'tokenLedger')).toBeUndefined()

    assistant(session, USAGE)
    await settle()
    await ctx.sessions.flush(session)
    const records = ledgerRecords(await storedEvents(ctx, session.id))
    expect(records).toHaveLength(1)
  })

  it('keeps a disposed Session\'s totals queryable by id', async () => {
    const { ctx } = await composition()
    let session: Session | undefined
    const scope = ctx.plugin({
      inject: ['sessions'],
      apply(owner) {
        session = owner.sessions.create(SessionId('retired-ledger-fixture'), { meta: { cwd: process.cwd() } })
      },
    })
    await scope.await()
    if (session === undefined) throw new Error('Expected the fixture Session to be created')
    assistant(session, USAGE)
    await settle()
    const id = session.id
    await scope.dispose()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.tokenLedger.forSession(id)?.totals).toEqual(ONE_CALL)
    expect(ctx.tokenLedger.global()).toEqual({ sessions: 1, totals: ONE_CALL })
  })
})
