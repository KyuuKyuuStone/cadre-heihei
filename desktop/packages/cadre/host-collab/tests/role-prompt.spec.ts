import { describe, expect, it } from 'vitest'
import { rosterLines, supervisorDuty, workerDuty } from '../src/index.ts'

const ROSTER = rosterLines([
  { name: '主管', role: 'supervisor' },
  { name: '架构师', role: 'worker', description: '负责边界划分、接口契约与技术取舍' },
])

describe('cadre-role prompt section', () => {
  it('pins the supervisor text with the roster at the end', async () => {
    const text = supervisorDuty(ROSTER)
    await expect(`${text}\n`).toMatchFileSnapshot('./expected/role-prompt-supervisor.txt')
    expect(text.endsWith(ROSTER)).toBe(true)
  })

  it('tells the supervisor to ask the user, not to create employees, when the roster is empty', () => {
    const text = supervisorDuty(rosterLines([]))
    expect(text.endsWith('（暂无员工。告诉用户需要哪些角色，请用户创建。）')).toBe(true)
    expect(text).not.toContain('先创建员工再派活')
  })

  it('pins the worker text: role line followed by the shared rules', async () => {
    const text = workerDuty({ name: '架构师', role: '负责边界划分、接口契约与技术取舍' })
    await expect(`${text}\n`).toMatchFileSnapshot('./expected/role-prompt-worker.txt')
    expect(text.startsWith('你的角色：架构师——负责边界划分、接口契约与技术取舍\n')).toBe(true)
  })
})
