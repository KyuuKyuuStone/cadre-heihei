// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CadreTaskNodeView, parseCadreTask } from '../src/client/chat/CadreTaskCard.tsx'
import { zh } from '../src/client/locale.ts'

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never

const TASK = `【主管任务】
任务号：task-1
标题：修复登录
截止：2026-11-12T18:00:00+08:00

交付要求：
只改 client，补测试。
不要 push。`

afterEach(cleanup)

describe('Cadre task card', () => {
  it('parses only the supervisor task prefix and extracts the summary', () => {
    expect(parseCadreTask(TASK)).toMatchObject({
      taskId: 'task-1', title: '修复登录', due: '2026-11-12T18:00:00+08:00',
    })
    expect(parseCadreTask(TASK)?.requirements).toContain('只改 client')
    expect(parseCadreTask('普通用户消息')).toBeUndefined()
    expect(parseCadreTask('【员工汇报】任务号：x')).toBeUndefined()
  })

  it('is collapsed by default, expands requirements, and collapses again', () => {
    render(<CadreTaskNodeView content={TASK} t={t} />)
    const card = document.querySelector('[data-cadre-task-card]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.getAttribute('data-expanded')).toBe('false')
    expect(card.className).toContain('card')
    expect(screen.getByText('主管任务')).toBeTruthy()
    expect(screen.getByText('修复登录')).toBeTruthy()
    expect(screen.getByText('任务号：task-1')).toBeTruthy()
    expect(screen.getByText('截止：2026-11-12T18:00:00+08:00')).toBeTruthy()
    expect(screen.queryByText(/只改 client/)).toBeNull()
    const toggle = screen.getByRole('button', { name: /主管任务/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/只改 client/)).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/只改 client/)).toBeNull()
  })
})
