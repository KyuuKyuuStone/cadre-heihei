import { describe, expect, it } from 'vitest'
import {
  TASK_PACKET_LIMITS, TOKEN_BUDGET, ambiguityAction, buildEmployeeContext, estimateTokens,
  measureTokenBudget, normalizeTaskPacket,
} from '../src/task-packet.ts'

describe('task packet', () => {
  it('normalizes all six fields and falls back when no packet is supplied', () => {
    const full = normalizeTaskPacket({
      goal: '实现导出', constraints: ['不改 schema'], fileRefs: [{ path: 'src/a.ts', lines: '1-20', summary: '入口' }],
      acceptance: ['pnpm test'], forbidden: ['不 push'], openQuestions: ['截止？'],
    }, { title: 't', body: 'b' })
    expect(full.packet).toEqual({
      goal: '实现导出', constraints: ['不改 schema'],
      fileRefs: [{ path: 'src/a.ts', lines: '1-20', summary: '入口' }],
      acceptance: ['pnpm test'], forbidden: ['不 push'], openQuestions: ['截止？'],
    })
    expect(full.warnings).toEqual([])

    const fallback = normalizeTaskPacket(undefined, { title: '修复登录', body: '测试通过' })
    expect(fallback.packet.goal).toBe('修复登录')
    expect(fallback.packet.acceptance).toEqual(['测试通过'])
    expect(fallback.warnings).toContain('goal-fallback')
  })

  it('truncates overlong fields to their limits and reports warnings', () => {
    const refs = Array.from({ length: TASK_PACKET_LIMITS.fileRefs + 1 }, (_, index) => ({
      path: `C:/${'x'.repeat(TASK_PACKET_LIMITS.filePathChars)}/${String(index)}.ts`,
      summary: 'y'.repeat(TASK_PACKET_LIMITS.fileSummaryChars + 10),
    }))
    const normalized = normalizeTaskPacket({
      goal: 'g'.repeat(TASK_PACKET_LIMITS.goalChars + 10),
      constraints: Array.from({ length: TASK_PACKET_LIMITS.listItems + 1 }, () => 'c'),
      fileRefs: refs,
      acceptance: ['a'],
      forbidden: ['f'],
      openQuestions: ['q'],
    }, { title: 't', body: 'b' })
    expect(normalized.packet.goal.length).toBeLessThanOrEqual(TASK_PACKET_LIMITS.goalChars)
    expect(normalized.packet.goal.endsWith('…')).toBe(true)
    expect(normalized.packet.constraints).toHaveLength(TASK_PACKET_LIMITS.listItems)
    expect(normalized.packet.fileRefs).toHaveLength(TASK_PACKET_LIMITS.fileRefs)
    expect(normalized.packet.fileRefs[0]!.path.length).toBeLessThanOrEqual(TASK_PACKET_LIMITS.filePathChars)
    expect(normalized.packet.fileRefs[0]!.summary!.length).toBeLessThanOrEqual(TASK_PACKET_LIMITS.fileSummaryChars)
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      'goal-truncated', 'constraints-truncated', 'fileRefs-truncated',
    ]))
  })

  it('builds employee context from the packet and one turn only, with ambiguity rules', () => {
    const { packet } = normalizeTaskPacket({
      goal: '目标', constraints: ['约束'], fileRefs: ['src/a.ts'],
      acceptance: ['验收'], forbidden: ['禁止'], openQuestions: ['问题'],
    }, { title: 't', body: 'b' })
    const context = buildEmployeeContext(packet, { lastTurn: '上轮结论' })
    expect(context).toContain('【员工任务包】')
    expect(context).toContain('目标：目标')
    expect(context).toContain('【上一轮摘要】\n上轮结论')
    expect(context).toContain('先向主管提问')
    expect(context).toContain('不要读取、推断或复述主管完整历史')
    expect(context).not.toContain('主管完整历史原文')
    expect(ambiguityAction(599_999)).toBe('none')
    expect(ambiguityAction(600_000)).toBe('remind')
    expect(ambiguityAction(1_800_000)).toBe('escalate')
  })
})

describe('token budget', () => {
  it('warns at 80% of task and round budgets without blocking', () => {
    const taskWarn = measureTokenBudget({
      taskId: 't1', sessionId: 's1', estimatedTokens: 100,
      taskTotal: TOKEN_BUDGET.task * 0.8, roundTotal: 100,
    })
    expect(taskWarn).toMatchObject({
      taskId: 't1', sessionId: 's1', estimatedTokens: 100, warnings: ['task-80%'],
    })
    const roundWarn = measureTokenBudget({
      taskId: 't1', sessionId: 's1', estimatedTokens: 100,
      taskTotal: 100, roundTotal: TOKEN_BUDGET.round * 0.8,
    })
    expect(roundWarn.warnings).toEqual(['round-80%'])
    const quiet = measureTokenBudget({
      taskId: 't1', sessionId: 's1', estimatedTokens: 100,
      taskTotal: TOKEN_BUDGET.task * 0.8 - 1, roundTotal: TOKEN_BUDGET.round * 0.8 - 1,
    })
    expect(quiet.warnings).toEqual([])
    expect(estimateTokens('x'.repeat(100))).toBe(50)
  })
})
