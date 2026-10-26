import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
// The scope tag is a module-level symbol. ToolRuntime's runtime copy resolves
// dsh-scope from lib, while the tsconfig path alias maps the bare specifier in
// this test to src; minting through the runtime copy keeps the tag identity.
// Keep a static ESM import (require() would load a second instance); the lib
// build ships no root declaration, so suppress TS7016 and take the package's
// source types for the call signature.
// @ts-expect-error -- runtime-only ESM copy of a declaration-less lib build
import { createScope as createScopeRuntime } from '../../../core/scope/lib/index.js'
const createScope = createScopeRuntime as typeof import('@deepseek-ai/dsh-scope').createScope
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyToolRestriction, type AgentToolsLike } from '../src/index.ts'

interface RestrictCall {
  readonly deny?: readonly string[]
  readonly allow?: readonly string[]
}

interface FakeOptions {
  readonly getThrows?: Error
  readonly restrictThrows?: Error
}

function fakeTools(visible: readonly string[], options: FakeOptions = {}): { tools: AgentToolsLike; calls: RestrictCall[] } {
  const calls: RestrictCall[] = []
  const tools: AgentToolsLike = {
    get(name) {
      if (options.getThrows !== undefined) throw options.getThrows
      return visible.includes(name) ? { name } : undefined
    },
    restrict(filter) {
      calls.push(filter)
      if (options.restrictThrows !== undefined && filter.deny !== undefined) throw options.restrictThrows
      return () => {}
    },
  }
  return { tools, calls }
}

const WORKER_MASK = ['dispatch_task', 'list_employees']

describe('applyToolRestriction', () => {
  it('drops tools that do not exist on this profile without error', () => {
    const { tools, calls } = fakeTools(['write', 'edit'])
    const outcome = applyToolRestriction(tools, ['bash', 'pwsh', 'write', 'edit'])

    expect(outcome).toMatchObject({ deny: ['write', 'edit'], absent: ['bash', 'pwsh'], failClosed: false })
    expect(calls).toEqual([{ deny: ['write', 'edit'] }])
  })

  it('skips restriction entirely when every target tool is absent', () => {
    const { tools, calls } = fakeTools([])
    const outcome = applyToolRestriction(tools, WORKER_MASK)

    expect(outcome).toMatchObject({ deny: [], absent: WORKER_MASK, failClosed: false })
    expect(calls).toEqual([])
    expect(() => outcome.lift()).not.toThrow()
  })

  it('fails closed when the visibility probe throws', () => {
    const { tools, calls } = fakeTools([], { getThrows: new Error('registry unavailable') })
    const outcome = applyToolRestriction(tools, WORKER_MASK)

    expect(outcome.failClosed).toBe(true)
    expect(outcome.reason).toContain('probe-error')
    expect(calls).toEqual([{ allow: [] }])
  })

  it('fails closed when no visibility probe is available', () => {
    const calls: RestrictCall[] = []
    const tools: AgentToolsLike = {
      restrict(filter) {
        calls.push(filter)
        return () => {}
      },
    }

    const outcome = applyToolRestriction(tools, WORKER_MASK)

    expect(outcome.failClosed).toBe(true)
    expect(outcome.reason).toBe('probe-unavailable')
    expect(calls).toEqual([{ allow: [] }])
  })

  it('fails closed when restrict() rejects the probed mask', () => {
    const { tools, calls } = fakeTools(['write'], { restrictThrows: new Error('unknown global tool "write"') })
    const outcome = applyToolRestriction(tools, ['write'])

    expect(outcome.failClosed).toBe(true)
    expect(outcome.reason).toContain('restrict-error')
    expect(calls).toEqual([{ deny: ['write'] }, { allow: [] }])
  })

  it.each([
    [''],
    ['write', ''],
    [' write '],
    ['write', 42],
    ['run_code'],
    [],
  ])('fails closed on an invalid mask %j', (...mask) => {
    const { tools, calls } = fakeTools(['write'])
    const outcome = applyToolRestriction(tools, mask)

    expect(outcome.failClosed).toBe(true)
    expect(outcome.reason).toMatch(/invalid-deny-entry|empty-deny-list/u)
    expect(calls).toEqual([{ allow: [] }])
  })

  it('never issues an empty deny mask', () => {
    const cases = [
      fakeTools([]),
      fakeTools(['write']),
      fakeTools([], { getThrows: new Error('boom') }),
    ]

    for (const { tools, calls } of cases) {
      applyToolRestriction(tools, ['bash', 'pwsh'])
      for (const call of calls) {
        expect(call.deny === undefined || call.deny.length > 0).toBe(true)
      }
    }
  })
})

function registryTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

interface RealRegistry {
  readonly ctx: Context
  readonly scope: Scope
  readonly key: Agent
}

async function mountRealRegistry(names: readonly string[]): Promise<RealRegistry> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const key = { id: 'agent-restrict' as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  for (const name of names) ctx.tools.register(registryTool(name))
  return { ctx, scope, key }
}

async function runTool(real: RealRegistry, name: string): Promise<string> {
  const result = await real.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('c1'),
    name,
    arguments: {},
    agent: real.key,
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('allow: [] against the real ToolRegistry', () => {
  it('masks every global tool, blocks execution, and lifts back', async () => {
    const real = await mountRealRegistry(['bash', 'write'])
    expect(real.ctx.tools.schemas(real.key).map(tool => tool.name).sort()).toEqual(['bash', 'write'])

    const outcome = applyToolRestriction(real.scope.ctx.tools, ['bash', 'write'])

    expect(outcome.failClosed).toBe(false)
    expect([...outcome.deny].sort()).toEqual(['bash', 'write'])
    expect(real.ctx.tools.schemas(real.key)).toEqual([])
    expect(await runTool(real, 'bash')).toMatch(/unknown tool "bash"/u)

    outcome.lift()
    expect(real.ctx.tools.schemas(real.key).map(tool => tool.name).sort()).toEqual(['bash', 'write'])
    expect(await runTool(real, 'bash')).toBe('ran:bash')
  })

  it('enforces fail-closed through the real registry when the mask is invalid', async () => {
    const real = await mountRealRegistry(['bash', 'write'])

    const outcome = applyToolRestriction(real.scope.ctx.tools, [])

    expect(outcome.failClosed).toBe(true)
    expect(real.ctx.tools.schemas(real.key)).toEqual([])
    expect(await runTool(real, 'write')).toMatch(/unknown tool "write"/u)

    outcome.lift()
    expect(real.ctx.tools.schemas(real.key).map(tool => tool.name).sort()).toEqual(['bash', 'write'])
  })
})
