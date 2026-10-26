import { describe, expect, it } from 'vitest'
import { loadRoster } from '../src/client/cadre-roster-source.ts'

describe('loadRoster', () => {
  it('carries the missing-roster warning next to an empty member list', async () => {
    const result = await loadRoster({
      listRoster: async () => ({
        rows: [],
        warning: { code: 'ROSTER_MISSING', message: '团队数据丢失或未找到：花名册为空。' },
      }),
    }, 'project-1', [])

    expect(result).toMatchObject({
      ok: true,
      members: [],
      warning: '团队数据丢失或未找到：花名册为空。',
    })
  })
})
