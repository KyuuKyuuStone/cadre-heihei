/**
 * 状态机规则表的表驱动测试：合法遍历、非法拒绝矩阵、review 必经、终态出边为零。
 * 规则来源只取 `TASK_TRANSITION_RULES`，不在此处复制矩阵。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TASK_STATUSES,
  TASK_TRANSITION_RULES,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
} from '../../src/collab/protocol/index.ts'
import {
  allowedActorsFor,
  deliveredMustPassReview,
  findTransitionRule,
  isTerminalStatus,
  isTransitionAllowed,
  listIllegalTransitionPairs,
  listLegalTransitions,
} from '../../src/collab/ledger/index.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

for (const rule of TASK_TRANSITION_RULES) {
  it(`合法迁移遍历：${rule.from} → ${rule.to}`, () => {
    const found = findTransitionRule(rule.from, rule.to)
    assert.ok(found, '规则表内组合必须可查')
    assert.equal(found.to, rule.to)
    assert.deepEqual(found.actors, rule.actors)
    assert.equal(isTransitionAllowed(rule.from, rule.to), true)
    assert.deepEqual(allowedActorsFor(rule.from, rule.to), rule.actors)
    assert.equal(isTerminalStatus(rule.from), false, '合法迁移的起点不得是终态')
  })
}

const illegalPairs = listIllegalTransitionPairs()
for (const { from, to } of illegalPairs) {
  it(`非法迁移拒绝矩阵：${from} → ${to}`, () => {
    assert.equal(findTransitionRule(from, to), undefined)
    assert.equal(isTransitionAllowed(from, to), false)
    assert.deepEqual(allowedActorsFor(from, to), [])
  })
}

it('review 必经：delivered 不得直达 verified / rework / failed', () => {
  assert.equal(deliveredMustPassReview(), true)
  assert.equal(isTransitionAllowed('delivered', 'review'), true)
  assert.equal(isTransitionAllowed('delivered', 'verified'), false)
  assert.equal(isTransitionAllowed('delivered', 'rework'), false)
  assert.equal(isTransitionAllowed('delivered', 'failed'), false)
})

for (const terminal of TERMINAL_TASK_STATUSES) {
  it(`终态锁死：${terminal} 无任何出边`, () => {
    assert.equal(isTerminalStatus(terminal), true)
    for (const to of TASK_STATUSES) {
      assert.equal(isTransitionAllowed(terminal, to), false, `${terminal} → ${to} 不应存在`)
    }
  })
}

it('矩阵完整性：合法 + 非法 = 状态全组合', () => {
  const legal = listLegalTransitions()
  assert.equal(legal.length, TASK_TRANSITION_RULES.length)
  assert.equal(legal.length + illegalPairs.length, TASK_STATUSES.length ** 2)
  const seen = new Set<string>()
  for (const { from, to } of legal) {
    const id = `${from}->${to}`
    assert.equal(seen.has(id), false, `规则重复：${id}`)
    seen.add(id)
  }
})

it('meta: 用例收集数 > 0（0 例即失败）', () => {
  const expected = TASK_TRANSITION_RULES.length + illegalPairs.length + 3 + TERMINAL_TASK_STATUSES.length
  assert.equal(registered, expected, `注册用例数 ${registered} ≠ 预期 ${expected}`)
  assert.ok(registered > 0)
})
