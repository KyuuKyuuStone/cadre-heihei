import { expect, it } from 'vitest'
import { providerOptionsFromCatalog } from '../src/provider-runtime.ts'

it('lists providers configured in the official model catalog', () => {
  const options = providerOptionsFromCatalog({
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
        ],
      },
      // A group without routable models has nothing to bind and is omitted.
      { id: 'empty', name: 'Empty', models: [] },
    ],
    failures: [],
  })

  expect(options).toHaveLength(1)
  expect(options[0]).toMatchObject({
    providerId: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    enabled: true,
    hasKey: true,
    isDefault: true,
  })
  expect(options[0]?.models[1]?.reasoning?.efforts[0]?.id).toBe('high')
})

it('falls back to the first model when the default belongs to another provider', () => {
  const options = providerOptionsFromCatalog({
    default: { provider: 'other', model: 'x' },
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }],
    failures: [],
  })

  expect(options[0]).toMatchObject({ defaultModel: 'deepseek-chat', isDefault: false })
})

it('returns no options for an empty catalog instead of throwing', () => {
  expect(providerOptionsFromCatalog({ groups: [], failures: [] })).toEqual([])
})
