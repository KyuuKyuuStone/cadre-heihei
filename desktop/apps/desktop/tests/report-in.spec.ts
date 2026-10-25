import { expect, it } from 'vitest'
import { reportInText } from '../src/report-in.ts'

it('supervisor report-in lists the active roster and asks for the roster back', () => {
  const text = reportInText({
    role: 'supervisor',
    name: '调度员',
    roster: [
      { sessionId: 's-1', displayName: '调度员', role: 'supervisor', state: 'ready' },
      { sessionId: 's-2', displayName: '前端', role: 'worker', state: 'ready' },
      { sessionId: 's-3', displayName: '已离职', role: 'worker', state: 'departed' },
    ],
  })

  expect(text).toContain('你是本项目部的主管「调度员」')
  expect(text).toContain('- 调度员（主管，ready）')
  expect(text).toContain('- 前端（员工，ready）')
  expect(text).not.toContain('已离职')
  expect(text).toContain('列出你当前看到的花名册')
})

it('supervisor report-in states an empty roster explicitly', () => {
  const text = reportInText({ role: 'supervisor', name: '调度员', roster: [] })
  expect(text).toContain('（暂无成员）')
})

it('employee report-in restates the duty and announces readiness', () => {
  const text = reportInText({ role: 'worker', name: '前端', duty: '负责界面与交互实现。' })

  expect(text).toContain('你是本项目部的员工「前端」')
  expect(text).toContain('岗位职责：负责界面与交互实现。')
  expect(text).toContain('复述你的职责')
  expect(text).toContain('等待主管派活')
})

it('employee report-in is explicit when the duty is missing', () => {
  const text = reportInText({ role: 'worker', name: '前端' })
  expect(text).toContain('岗位职责：（未填写）')
})
