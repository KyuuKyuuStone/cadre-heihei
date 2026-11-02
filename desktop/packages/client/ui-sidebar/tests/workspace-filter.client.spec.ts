import { describe, expect, it } from 'vitest'
import { isInternalWorkspaceTitle } from '../src/client/workspace-filter.ts'

describe('Cadre internal workspace filter', () => {
  it('hides the skill-administrator workspace from project lists', () => {
    expect(isInternalWorkspaceTitle('技能管理员工作区（内部）')).toBe(true)
    expect(isInternalWorkspaceTitle('Skill admin (internal)')).toBe(true)
    expect(isInternalWorkspaceTitle('项目部 A')).toBe(false)
  })
})
