import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { CompactionCardController, type CompactionSettings } from '../src/client/compaction-card-controller.ts'

/** Make the stub apply ordered writes like the Host settings document. */
function acceptWrites(host: StubConfigForm<CompactionSettings>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(value, field)
        Reflect.deleteProperty(user, field)
      }
    }
    host.publish({ value, user })
    return Promise.resolve(true)
  })
}

function ready(host: StubConfigForm<CompactionSettings>, value: CompactionSettings, user: CompactionSettings = {}): void {
  host.publish({ status: 'ready', writable: true, value, base: {}, user, revision: 7 })
}

describe('CompactionCardController', () => {
  it('keeps absent values inherited and saves both editable fields atomically', async () => {
    const host = stubConfigForm<CompactionSettings>()
    acceptWrites(host)
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    const face = controller.inject()
    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({
      auto: { text: '', overridden: false },
      thresholdRatio: { text: '', overridden: false },
    })

    face.edit('auto', 'false')
    face.edit('thresholdRatio', '0.95')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['auto'], value: false },
        { op: 'set', path: ['thresholdRatio'], value: 0.95 },
      ], 7)
    })
    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({
      dirty: false,
      failed: false,
      auto: { text: 'false', overridden: true },
      thresholdRatio: { text: '0.95', overridden: true },
    })
  })

  it('distinguishes explicit true and false from an absent auto override', () => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    const snapshot = controller.inject().hooks.compactionCard.getSnapshot
    ready(host, { auto: true }, { auto: true })
    expect(snapshot().auto).toMatchObject({ text: 'true', overridden: true })
    ready(host, { auto: false }, { auto: false })
    expect(snapshot().auto).toMatchObject({ text: 'false', overridden: true })
    ready(host, { auto: true })
    expect(snapshot().auto).toMatchObject({ text: 'true', overridden: false })
  })

  it('unsets auto through reset and ratio through a blank draft', async () => {
    const host = stubConfigForm<CompactionSettings>()
    acceptWrites(host)
    const controller = new CompactionCardController(host.scope)
    ready(host, { auto: false, thresholdRatio: 0.8 }, { auto: false, thresholdRatio: 0.8 })
    const face = controller.inject()

    face.resetField('auto')
    face.edit('thresholdRatio', '  ')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'unset', path: ['auto'] },
        { op: 'unset', path: ['thresholdRatio'] },
      ], 7)
    })
    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({
      auto: { text: '', overridden: false },
      thresholdRatio: { text: '', overridden: false },
    })
  })

  it('unsets an explicit auto override when inherit is selected', async () => {
    const host = stubConfigForm<CompactionSettings>()
    acceptWrites(host)
    const controller = new CompactionCardController(host.scope)
    ready(host, { auto: false }, { auto: false })
    const face = controller.inject()

    face.edit('auto', '')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['auto'] }], 7)
    })
    expect(face.hooks.compactionCard.getSnapshot().auto).toMatchObject({ text: '', overridden: false })
  })

  it('rejects an invalid auto draft without writing a string to the Host', () => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    const face = controller.inject()

    face.edit('auto', 'yes')
    face.save()

    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({ dirty: true, invalid: true, auto: { invalid: true } })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it.each(['0', '-0', '-0.1', '1.01', 'NaN', 'Infinity', 'not-a-number'])('blocks the invalid ratio %s', (text) => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    const face = controller.inject()

    face.edit('thresholdRatio', text)
    face.save()

    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({ invalid: true, thresholdRatio: { invalid: true } })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it.each(['1', String(Number.MIN_VALUE)])('accepts the inclusive ratio boundary %s', async (text) => {
    const host = stubConfigForm<CompactionSettings>()
    acceptWrites(host)
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    const face = controller.inject()

    face.edit('thresholdRatio', text)
    face.save()
    await vi.waitFor(() => { expect(face.hooks.compactionCard.getSnapshot().dirty).toBe(false) })

    expect(host.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['thresholdRatio'], value: Number(text) }], 7)
  })

  it('does not write a read-only document', () => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    host.publish({ writable: false })
    const face = controller.inject()

    face.edit('auto', 'true')
    face.save()

    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({ writable: false, dirty: true })
  })

  it('keeps drafts after refusal or a transport failure and clears failure on the next edit', async () => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    ready(host, {})
    const face = controller.inject()
    host.mutate.mockResolvedValue(false)

    face.edit('thresholdRatio', '0.5')
    face.save()
    await vi.waitFor(() => { expect(face.hooks.compactionCard.getSnapshot().failed).toBe(true) })
    expect(face.hooks.compactionCard.getSnapshot()).toMatchObject({ dirty: true, thresholdRatio: { text: '0.5' } })

    face.edit('thresholdRatio', '0.6')
    expect(face.hooks.compactionCard.getSnapshot().failed).toBe(false)
    host.mutate.mockRejectedValue(new Error('offline'))
    face.save()
    await vi.waitFor(() => { expect(face.hooks.compactionCard.getSnapshot().failed).toBe(true) })
    expect(face.hooks.compactionCard.getSnapshot().thresholdRatio.text).toBe('0.6')
  })

  it('releases the Host form subscription on dispose', () => {
    const host = stubConfigForm<CompactionSettings>()
    const controller = new CompactionCardController(host.scope)
    expect(host.listenerCount()).toBe(1)

    controller.dispose()

    expect(host.listenerCount()).toBe(0)
  })
})
