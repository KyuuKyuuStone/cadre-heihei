/**
 * 客户端命令判定口径（表驱动）：
 * 前导空白 trim、整 token 匹配、大小写不敏感、只检查首个 token（代码块/行内提及放行）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchClientCommand } from '../../src/collab/dispatch/index.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

const CASES: ReadonlyArray<{ readonly body: string; readonly expected: string | null; readonly why: string }> = [
  { body: '/compact', expected: '/compact', why: '精确命中' },
  { body: '  /compact now', expected: '/compact', why: '前导空白 trim 后命中' },
  { body: '\t/clear\n', expected: '/clear', why: '制表/换行空白照常 trim' },
  { body: '/CLEAR', expected: '/CLEAR', why: '大小写不敏感，返回原始 token' },
  { body: '/Compact 请总结', expected: '/Compact', why: '命令后带参数仍然命中' },
  { body: '\uFEFF/compact', expected: '/compact', why: 'BOM 属于 JS 空白，trimStart 后命中' },
  { body: '```\n/compact\n```', expected: null, why: '代码围栏开头不是 /，放行' },
  { body: '请执行 /compact', expected: null, why: '只检查首个 token，正文内提及放行' },
  { body: '/compactx', expected: null, why: '整 token 不等，不得按前缀拒绝' },
  { body: '/clearup', expected: null, why: '整 token 不等' },
  { body: '/unknown', expected: null, why: '未登记命令放行' },
  { body: '/', expected: null, why: '无命令 token' },
  { body: '', expected: null, why: '空正文由 EMPTY_BODY 处理，不在本层拒绝' },
]

for (const testCase of CASES) {
  it(`命令判定：${JSON.stringify(testCase.body)} → ${testCase.expected ?? '放行'}（${testCase.why}）`, () => {
    assert.equal(matchClientCommand(testCase.body), testCase.expected)
  })
}

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})
