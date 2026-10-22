// Boots the shipped Web composition and proves the four Cadre employee presets
// are real roster entries the registry can read and select for a blank Session.
// Design: docs/product/design/05-employee-presets.md.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const CADRE = ['cadre-dev', 'cadre-novel', 'cadre-general', 'cadre-roleplay'] as const

let scaffold: WebScaffold

beforeAll(async () => {
  scaffold = await launchWebScaffold({
    profile: {
      packages: [{ dir: fileURLToPath(new URL('../../../packages/bundle/cadre-app', import.meta.url)) }],
      bundles: ['@deepseek-ai/dsh-bundle-cadre'],
    },
  })
}, 120_000)

afterAll(async () => {
  await scaffold?.close()
})

it('lists the Cadre presets with no diagnostics and reads one declaration', async () => {
  const roster = await scaffold.ctx.agentPresets.remoteExportList()
  const ids = roster.presets.map(preset => preset.id)
  for (const id of CADRE) expect(ids).toContain(id)
  for (const id of CADRE) {
    const row = roster.presets.find(preset => preset.id === id)
    expect(row?.broken, `${id} diagnostics`).toBeUndefined()
    expect(row?.isDefault).toBe(false)
  }
  expect(roster.presets.find(preset => preset.id === 'cadre-roleplay')?.name).toBe('角色扮演 · Role-play')

  const document = await scaffold.ctx.agentPresets.readDocument('cadre-dev')
  expect(document.agentPreset).toBe('cadre-dev')
  expect(document.content).toContain('@deepseek-ai/dsh-persona')
  expect(document.content).toContain('@deepseek-ai/dsh-tool-pwsh')
})

it('selects cadre-general for a blank Session that started under cadre-roleplay', async () => {
  const sessionId = SessionId('cadre-e2e-blank')
  const handle = await scaffold.ctx.agents.create({
    sessionId,
    setup: async (agentCtx) => { await scaffold.ctx.agentPresets.mount(agentCtx, 'cadre-roleplay') },
  })
  try {
    expect(scaffold.ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('cadre-roleplay')
    expect(await scaffold.ctx.agentPresets.select(handle.agent, 'cadre-general')).toBe('cadre-general')
    expect(scaffold.ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('cadre-general')
  } finally {
    await handle.dispose()
  }
})
