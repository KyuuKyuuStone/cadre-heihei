import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
// Source plane on purpose: the scope tag is a module-level symbol, so the
// runtime and the scope must come from one module instance. Vitest resolves
// the bare specifier to `src`, hence `createScope` from the same specifier.
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyToolRestriction, SUPERVISOR_TOOL_DENY, WORKER_TOOL_DENY, type AgentToolsLike } from '../src/index.ts'

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

describe('role masks against the real ToolRegistry', () => {
  const tools = [
    'ask_user_question', 'resolve_employee_question', 'dispatch_task', 'list_employees', 'transition_task',
    'report_task', 'bash', 'pwsh', 'write', 'edit', 'str_replace_editor',
  ]

  it('worker keeps the question tool and loses dispatch/transition/list_employees', async () => {
    const real = await mountRealRegistry(tools)
    const outcome = applyToolRestriction(real.scope.ctx.tools, WORKER_TOOL_DENY)
    expect(outcome.failClosed).toBe(false)
    const visible = real.ctx.tools.schemas(real.key).map(tool => tool.name)
    expect(visible).toContain('ask_user_question')
    expect(visible).toContain('report_task')
    expect(visible).not.toContain('dispatch_task')
    expect(visible).not.toContain('list_employees')
    expect(visible).not.toContain('transition_task')
    outcome.lift()
    expect(real.ctx.tools.schemas(real.key).map(tool => tool.name).sort()).toEqual([...tools].sort())
    await real.ctx.fiber.dispose()
  })

  it('supervisor keeps question/decision tools and loses write/report_task', async () => {
    const real = await mountRealRegistry(tools)
    const outcome = applyToolRestriction(real.scope.ctx.tools, SUPERVISOR_TOOL_DENY)
    expect(outcome.failClosed).toBe(false)
    const visible = real.ctx.tools.schemas(real.key).map(tool => tool.name)
    expect(visible).toContain('ask_user_question')
    expect(visible).toContain('resolve_employee_question')
    expect(visible).not.toContain('write')
    expect(visible).not.toContain('report_task')
    expect(visible).not.toContain('bash')
    expect(visible).not.toContain('pwsh')
    expect(visible).not.toContain('edit')
    expect(visible).not.toContain('str_replace_editor')
    outcome.lift()
    await real.ctx.fiber.dispose()
  })
})

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

  it('fails closed instead of masking every agent when the registry is unscoped', async () => {
    const real = await mountRealRegistry(['bash', 'write'])

    // A context-global registry cannot target one agent; the wrapper must throw
    // rather than fall back to a mask that would hide tools from every agent.
    expect(() => applyToolRestriction(real.ctx.tools, ['bash', 'write']))
      .toThrow(/fail-closed 无法禁用全局工具/u)

    // The refusal must leave the shared registry untouched.
    expect(real.ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['bash', 'write'])
    expect(await runTool(real, 'bash')).toBe('ran:bash')
  })
})
