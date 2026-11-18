/**
 * REAL-composition coverage: a test-only cordis.yml boots host-governance
 * through the vendored Loader with optional systemPrompt present and the
 * compaction service isolated inside the Agent preset composition.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import * as HostGovernance from '../src/index.ts'

interface PromptSection {
  readonly name: string
  readonly text: (context: { scope?: unknown }) => string
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

async function loadComposition(): Promise<{
  readonly agent: { id: string; status: string; session: { snapshotEvents(): readonly never[] }; ctx?: Context }
  readonly compactCalls: () => number
  readonly presetLookups: () => number
  readonly promptSections: PromptSection[]
}> {
  root = await mkdtemp(join(tmpdir(), 'host-governance-composition-'))
  const databasePath = join(root, 'cadre.sqlite')
  initCadreStore(databasePath)
  const db = new DatabaseSync(databasePath)
  try {
    const at = '2026-11-07T00:00:00.000Z'
    db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES ('p1', 'sup', 'supervisor', '主管', 'available', ?, ?)`).run(at, at)
    db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes,
      body_sha256, status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
      VALUES ('t1', 'p1', 1, '已完成任务', '完成内容', 1, 'sha', 'verified', 'sup', 'sup', ?, ?)`).run(at, at)
    db.prepare(`INSERT INTO task_memory
      (task_id, project_id, name, status, summary, decisions_json, artifacts_json, transcript_ref, updated_at)
      VALUES ('t1', 'p1', '已完成任务', 'verified', '已完成任务｜完成内容', '[]', '[]', 'task:t1', ?)`).run(at)
  } finally {
    db.close()
  }
  vi.stubEnv('CADRE_LEDGER_PATH', databasePath)

  const session = { snapshotEvents: () => [] as const }
  const agent: { id: string; status: string; session: typeof session; ctx?: Context } = {
    id: 'sup', status: 'idle', session,
  }
  const promptSections: PromptSection[] = []
  let compactCalls = 0
  let presetLookups = 0
  let isolatedCompaction: {
    compactNow(target: typeof agent, signal: AbortSignal): Promise<{ compacted: boolean }>
  } | undefined
  const goal = { id: 'goal', revision: 1, phase: 'active' as const, activation: 'armed' as const }
  const dependencies = {
    name: 'test:host-dependencies',
    apply(ctx: Context): void {
      ctx.provide('tools', { register: () => () => {} })
      ctx.provide('sessionController', { prompt: async () => ({}) })
      ctx.provide('sessions', { get: () => session, list: () => [session] })
      ctx.provide('sessionQuery', { readSession: async () => ({ events: [] }) })
      ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      ctx.provide('goals', {
        get: () => undefined, create: () => goal, resume: () => goal,
        pause: () => goal, complete: () => goal, disarm: () => goal,
      })
      ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 60_000 }) })
      ctx.provide('agentPresets', {
        serviceFor: (target: typeof agent, name: string) => {
          expect(target).toBe(agent)
          expect(name).toBe('compaction')
          presetLookups += 1
          return isolatedCompaction
        },
      })
      ctx.provide('systemPrompt', {
        context: (section: PromptSection) => {
          promptSections.push(section)
          return () => { promptSections.splice(promptSections.indexOf(section), 1) }
        },
      })
    },
  }
  const agentScope = {
    name: 'test:agent-scope',
    apply(ctx: Context): void {
      const service = {
        compactNow: async (target: typeof agent, signal: AbortSignal) => {
          expect(target).toBe(agent)
          expect(signal).toBeInstanceOf(AbortSignal)
          compactCalls += 1
          return { compacted: true }
        },
      }
      isolatedCompaction = service
      ctx.provide('compaction', service)
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test:host-dependencies'",
    "- name: 'test:agent-scope'",
    '  isolate:',
    '    compaction: true',
    "- name: '@deepseek-ai/dsh-host-governance'",
    '',
  ].join('\n'))
  context = new Context()
  agent.ctx = context
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test:host-dependencies', dependencies],
    ['test:agent-scope', agentScope],
    ['@deepseek-ai/dsh-host-governance', HostGovernance],
  ])
  Object.defineProperty(context.loader, 'internal', {
    value: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { agent, compactCalls: () => compactCalls, presetLookups: () => presetLookups, promptSections }
}

describe('host-governance real Loader composition', () => {
  it('activates optional prompt memory and resolves isolated compaction through the preset registry', async () => {
    const mounted = await loadComposition()
    const ctx = context
    if (ctx === undefined) throw new Error('composition context missing')
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(ctx.get('compaction')).toBeUndefined()
    expect(mounted.agent.ctx?.get('compaction')).toBeUndefined()
    expect(mounted.promptSections.map(section => section.name)).toEqual(['cadre/task-memory'])
    expect(mounted.promptSections[0]?.text({ scope: { session: { id: 'sup' } } })).toContain('已完成任务')

    ctx.emit('agent/status', { agent: mounted.agent, status: 'idle' } as never)
    await vi.waitFor(() => { expect(mounted.compactCalls()).toBe(1) })
    expect(mounted.presetLookups()).toBeGreaterThan(0)
    ctx.emit('agent/status', { agent: mounted.agent, status: 'idle' } as never)
    await Promise.resolve()
    expect(mounted.compactCalls()).toBe(1)

    await ctx.fiber.dispose()
    context = undefined
    expect(mounted.promptSections).toEqual([])
  })
})
