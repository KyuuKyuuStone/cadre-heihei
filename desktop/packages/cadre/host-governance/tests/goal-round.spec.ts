import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    for (const chunk of entry) yield chunk
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function waitForGoal(ctx: Context, agent: Agent, predicate: (goal: GoalView | undefined) => boolean): Promise<GoalView | undefined> {
  await vi.waitFor(() => { expect(predicate(ctx.goals.get(agent))).toBe(true) })
  return ctx.goals.get(agent)
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('DF-014 goal auto-continue', () => {
  it('runs one automatic round for the supervisor project goal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(goalDriver)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([textResponse('round one')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('df014-goal'), { provider: 'mock', model: 'mock' })

    ctx.goals.create(agent, { objective: '推进本项目所有未结任务到 verified', maxGoalRounds: 1 })
    const final = await waitForGoal(ctx, agent, goal => goal?.phase === 'blocked')
    expect(adapter.requests).toHaveLength(1)
    expect(final).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
  })
})
