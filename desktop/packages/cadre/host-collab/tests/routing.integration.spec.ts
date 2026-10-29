import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import { apply as applyRemotes, inject as remotesInject } from '@deepseek-ai/dsh-api-remotes'
import type { TypertRemoteEventInvocation, TypertRemoteEventSource } from '@deepseek-ai/dsh-api-gateway'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import { apply } from '../src/index.ts'

const PROJECT = 'p-route'
const SUP = 'sup-route'
const WORKER = 'worker-route'
const AT = '2026-11-02T08:00:00.000Z'
const roots: string[] = []
const previousLedger = process.env.CADRE_LEDGER_PATH

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousLedger === undefined) delete process.env.CADRE_LEDGER_PATH
  else process.env.CADRE_LEDGER_PATH = previousLedger
})

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'df011-route-'))
  roots.push(root)
  const path = join(root, 'cadre.sqlite')
  initCadreStore(path)
  const db = new DatabaseSync(path)
  try {
    const member = db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    member.run(PROJECT, SUP, 'supervisor', '主管', AT, AT)
    member.run(PROJECT, WORKER, 'worker', '小明', AT, AT)
    db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256,
      status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
      VALUES ('t1', ?, 1, '实现登录', 'body', 4, 'sha', 'in_progress', ?, ?, ?, ?)`)
      .run(PROJECT, SUP, WORKER, AT, AT)
  } finally {
    db.close()
  }
  return path
}

function stubAgent(id: string): Agent {
  const agentId = SessionId(id)
  return {
    id: agentId,
    options: {},
    session: Session.create(agentId, [], {
      version: SESSION_FORMAT_VERSION, id: agentId, createdAt: 0, isSeeded: false,
    }),
    inbox: {
      nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [],
    },
    status: 'idle',
    ctx: new Context(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

interface Mounted {
  readonly ctx: Context
  readonly prompts: string[]
  readonly source: TypertRemoteEventSource
}

async function mount(timeoutMs: number): Promise<Mounted> {
  const path = seed()
  process.env.CADRE_LEDGER_PATH = path
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(toolAskUser, { mode: 'timed', timeout: -1 })
  // The real client transport (same forwarder the GUI uses) must exist before Cadre.
  let source: TypertRemoteEventSource | undefined
  ctx.reflect.provide('typertGateway', {
    registerRemoteEvents(candidate: TypertRemoteEventSource) {
      source = candidate
      return async () => { source = undefined }
    },
  })
  await ctx.plugin({ inject: [...remotesInject], apply: applyRemotes })
  if (source === undefined) throw new Error('remotes source missing')
  const prompts: string[] = []
  const host = {
    tools: ctx.tools,
    effect: (setup: () => () => void) => ctx.effect(setup),
    on: (event: string, handler: never, options?: { prepend?: boolean }) => ctx.on(event as never, handler as never, options),
    sessionController: {
      prompt: (request: { content: readonly { text: string }[] }) => {
        prompts.push(request.content[0]?.text ?? '')
        return Promise.resolve()
      },
    },
  }
  apply(host as never, { questionTimeoutMs: timeoutMs })
  return { ctx, prompts, source }
}

/** True when the real client transport received a user-question frame within the window. */
async function forwardedUserQuestion(source: TypertRemoteEventSource, signal: AbortSignal): Promise<boolean> {
  const iterator = source(signal)[Symbol.asyncIterator]()
  const next = iterator.next()
  const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 80))
  const result = await Promise.race([next, timeout])
  if (result === 'timeout') return false
  if (result.done === true) return false
  const dispatch = result.value
  if (dispatch.event !== 'user-questions/request') return false
  if (!('context' in dispatch)) return false
  ;(dispatch as TypertRemoteEventInvocation).resolve({ kind: 'result', value: { answers: [{ id: 'q1', selected: ['被 UI 抢答'] }] } })
  return true
}

describe('DF-011 real Cordis composition (worker ask -> supervisor -> resolve)', () => {
  it('keeps the user answerer out, prompts the supervisor, and resumes the worker tool', async () => {
    const mounted = await mount(30 * 60_000)
    const { ctx, prompts } = mounted
    try {
      const worker = stubAgent(WORKER)
      const supervisor = stubAgent(SUP)
      ctx.agents.enter(worker, undefined)
      ctx.agents.enter(supervisor, undefined)

      const transport = new AbortController()
      const asking = ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('ask-route-1'),
        name: 'ask_user_question',
        arguments: { questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] },
        agent: worker,
      })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(await forwardedUserQuestion(mounted.source, transport.signal)).toBe(false)
      transport.abort()
      expect(prompts.some(text => text.includes('【员工请示 #ask-route-1】'))).toBe(true)

      const resolved = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('resolve-1'),
        name: 'resolve_employee_question',
        arguments: { questionId: 'ask-route-1', action: 'answer', answers: [{ id: 'q1', selected: ['A'] }] },
        agent: supervisor,
      })
      expect(resolved.isError).toBe(false)
      await expect(asking).resolves.toMatchObject({ isError: false })
      const result = await asking
      expect(JSON.stringify(result)).toContain('"selected":["A"]')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)

  it('resumes the worker with a late answer after the timeout escalation', async () => {
    const mounted = await mount(10)
    const { ctx, prompts } = mounted
    try {
      const worker = stubAgent(WORKER)
      const supervisor = stubAgent(SUP)
      ctx.agents.enter(worker, undefined)
      ctx.agents.enter(supervisor, undefined)

      const transport = new AbortController()
      const asking = ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('ask-route-2'),
        name: 'ask_user_question',
        arguments: { questions: [{ id: 'q1', question: '继续吗？' }] },
        agent: worker,
      })
      expect(await forwardedUserQuestion(mounted.source, transport.signal)).toBe(false)
      transport.abort()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(prompts.some(text => text.includes('超时升级'))).toBe(true)

      const resolved = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('resolve-2'),
        name: 'resolve_employee_question',
        arguments: { questionId: 'ask-route-2', action: 'answer', answers: [{ id: 'q1', selected: ['继续'] }] },
        agent: supervisor,
      })
      expect(resolved.isError).toBe(false)
      await expect(asking).resolves.toMatchObject({ isError: false })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)
})
