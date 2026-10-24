// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCustomRoles, removeCustomRole, saveCustomRole } from '../src/client/cadre-roster-source.ts'

const CUSTOM_ROLE_KEY = 'cadre.customRoles'

describe('custom role storage', () => {
  beforeEach(() => { localStorage.clear() })

  it('saves, replaces by name, reloads, and removes without touching earlier entries', () => {
    saveCustomRole({ id: 'role-a', name: '数据工程', description: '负责数据管线' })
    // Same name replaces the old row instead of duplicating it.
    saveCustomRole({ id: 'role-b', name: '数据工程', description: '负责数据管线与报表' })
    expect(loadCustomRoles()).toEqual([{ id: 'role-b', name: '数据工程', description: '负责数据管线与报表' }])

    saveCustomRole({ id: 'role-c', name: '翻译', description: '负责中英互译' })
    expect(loadCustomRoles().map(role => role.name)).toEqual(['数据工程', '翻译'])

    expect(removeCustomRole('role-b').map(role => role.name)).toEqual(['翻译'])
    // Removal is persisted, not only returned.
    expect(loadCustomRoles().map(role => role.name)).toEqual(['翻译'])
  })

  it('degrades malformed storage to an empty list', () => {
    localStorage.setItem(CUSTOM_ROLE_KEY, '{"not":"an array"}')
    expect(loadCustomRoles()).toEqual([])
    localStorage.setItem(CUSTOM_ROLE_KEY, '[{"id":1,"name":"bad"}]')
    expect(loadCustomRoles()).toEqual([])
    localStorage.setItem(CUSTOM_ROLE_KEY, 'not-json')
    expect(loadCustomRoles()).toEqual([])
  })
})
