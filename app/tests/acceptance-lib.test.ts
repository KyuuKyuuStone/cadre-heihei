/**
 * acceptance-lib 单测（从 cc-heihei v1.7.9 的 acceptance-lib.test.ts 迁移，
 * bun:test → node:test）。这些用例同时构成 smoke 门禁的非空用例集。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyFailures,
  classifyRerunDistribution,
  isRerunGreen,
  matchKnownFlaky,
  parseJunit,
  verdict,
  type JunitCase,
} from '../scripts/gates/acceptance-lib.ts'

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="10" failures="1" skipped="1" time="12.5">
  <testsuite name="src\\server\\__tests__\\demo.test.ts" file="src\\server\\__tests__\\demo.test.ts" tests="3" failures="1" skipped="1" time="1.2">
    <testcase name="green case" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0.1" />
    <testcase name="broken case &lt;with xml&gt;" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0.2">
      <failure message="EPERM: operation not permitted, rename">at assertFileIdentity</failure>
    </testcase>
    <testcase name="skipped case" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`

test('parseJunit: pass/fail/skip 统计与失败归属', () => {
  const parsed = parseJunit(SAMPLE_XML)
  assert.equal(parsed.total, 3)
  assert.equal(parsed.fail, 1)
  assert.equal(parsed.skipped, 1)
  assert.equal(parsed.pass, 1)
  assert.equal(parsed.durationSec, 12.5)
  assert.equal(parsed.failures.length, 1)
  assert.equal(parsed.failures[0]!.name, 'broken case <with xml>')
  assert.equal(parsed.failures[0]!.file, 'src/server/__tests__/demo.test.ts')
  assert.match(parsed.failures[0]!.message ?? '', /EPERM/)
})

test('parseJunit: 空输出与坏输入不抛错', () => {
  for (const input of ['', '<not-junit>', '<testsuites></testsuites>']) {
    const parsed = parseJunit(input)
    assert.equal(parsed.failures.length, 0)
    assert.equal(parsed.total, 0)
    assert.equal(parsed.cases.length, 0)
  }
})

test('parseJunit: vitest 风格无 file 时回退 classname', () => {
  const vitestXml = `<testsuites tests="1" failures="1" time="3">
    <testsuite name="demo.test.ts" tests="1" failures="1">
      <testcase classname="src/x/a.test.ts &gt; suite" name="red test">
        <failure>expected 1 to be 2</failure>
      </testcase>
    </testsuite>
  </testsuites>`
  const parsed = parseJunit(vitestXml)
  assert.equal(parsed.failures[0]!.name, 'red test')
  assert.match(parsed.failures[0]!.file, /a\.test\.ts/)
  assert.match(parsed.failures[0]!.message ?? '', /expected 1 to be 2/)
})

test('parseJunit: cases 保留 classname 二元组', () => {
  const parsed = parseJunit(SAMPLE_XML)
  assert.equal(parsed.cases.length, 3)
  assert.equal(parsed.cases[0]!.classname, 'demo suite')
  assert.equal(parsed.failures[0]!.classname, 'demo suite')
})

test('matchKnownFlaky: 子串命中返回 reason，未命中返回 undefined', () => {
  const list = [{ test: 'serializes concurrent updates', reason: 'FS 争用型' }]
  assert.equal(matchKnownFlaky('Agents API > serializes concurrent updates by target', list), 'FS 争用型')
  assert.equal(matchKnownFlaky('other test', list), undefined)
  assert.equal(matchKnownFlaky('other test', []), undefined)
})

test('isRerunGreen: 0 用例/目标缺失/目标失败均判红，目标通过才绿', () => {
  const failure: JunitCase = { name: 'red', classname: 'suite', file: 'a.test.ts', failed: true }
  const empty = parseJunit('<testsuites></testsuites>')
  assert.equal(isRerunGreen(empty, failure), false)

  const greenCase: JunitCase = { name: 'red', classname: 'suite', file: 'a.test.ts', failed: false }
  const rerun = { ...empty, total: 1, cases: [greenCase] }
  assert.equal(isRerunGreen(rerun, failure), true)

  const redCase: JunitCase = { ...greenCase, failed: true }
  assert.equal(isRerunGreen({ ...empty, total: 1, cases: [redCase] }, failure), false)

  const otherCase: JunitCase = { ...greenCase, name: 'other' }
  assert.equal(isRerunGreen({ ...empty, total: 1, cases: [otherCase] }, failure), false)
})

test('classifyRerunDistribution: 3 次复跑 ≥2 红判真回归，1 红判环境噪声', () => {
  assert.equal(classifyRerunDistribution(2, 3), 'env-noise')
  assert.equal(classifyRerunDistribution(1, 3), 'real-regression')
  assert.equal(classifyRerunDistribution(0, 3), 'real-regression')
})

test('classifyFailures/verdict: 复跑绿=环境噪声，复跑红=真回归', () => {
  const failures: JunitCase[] = [
    { name: 'flaky', classname: 's', file: 'a.test.ts', failed: true },
    { name: 'real', classname: 's', file: 'b.test.ts', failed: true },
  ]
  const rerun = new Map<string, boolean>([['a.test.ts\u0000flaky', true]])
  const classified = classifyFailures(failures, rerun, [])
  assert.equal(classified[0]!.kind, 'env-noise')
  assert.equal(classified[1]!.kind, 'real-regression')
  assert.deepEqual(verdict(classified), { result: 'FAIL', realRegressions: 1, envNoise: 1 })
  assert.deepEqual(verdict([classified[0]!]), { result: 'PASS', realRegressions: 0, envNoise: 1 })
})
