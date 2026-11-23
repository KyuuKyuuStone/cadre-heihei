/** Browser registration follows the real served-namespace watch and fiber lifetime. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { CompactionCardFace } from '../src/client/compaction-card-controller.ts'
import { apply as hostApply } from '../src/index.ts'

function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, remote }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-compaction apply', () => {
  it('keeps the Host Loader entry inert and declares browser services', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('registers a localized page only for the compaction-settings namespace', async () => {
    const { ctx, slots } = await bench(['compaction-settings', 'shell'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'compaction-settings', order: 35 })
    expect(resolveSlotLabel(entry.options.label)).toBe('上下文压缩')
    expect(entry.locale).toBe('settings.compaction')
    const face = (entry.inject as () => Pick<CompactionCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['compactionCard'])
  })

  it('appears when the namespace arrives and withdraws when it disappears', async () => {
    const { ctx, slots, describeSettings, remote } = await bench(['shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    expect(slots.entries('plugins.item')).toHaveLength(0)

    describeSettings.mockResolvedValue({
      ok: true, value: { writable: true, hasDocument: true, namespaces: [view('compaction-settings', 1)] },
    })
    remote.emit('settings/document-updated', ['compaction-settings', 1])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    describeSettings.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    remote.emit('settings/document-updated', ['compaction-settings', 2])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(0) })
  })

  it('waits for the Plugins slot declaration', async () => {
    const { ctx, slots } = await bench(['compaction-settings'])
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(ctx.get('configForms')).toBeDefined() })
    expect(slots.entries('plugins.item')).toHaveLength(0)

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['compaction-settings'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
