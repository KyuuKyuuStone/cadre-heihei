// 搬迁测试的最小断言适配层。
// 前身测试使用 vitest 的 expect 风格；新项目测试 runner 为 node:test。
// 这里只映射搬迁测试实际用到的 matcher，底层仍是 node:assert/strict，
// 不引入 vitest 依赖。新增 matcher 时必须同时补一条会红的自测。
import assert from 'node:assert/strict'

function includes(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected))
  if (Array.isArray(actual)) return actual.includes(expected)
  if (actual instanceof Set) return actual.has(expected)
  throw new TypeError(`toContain 不支持的类型: ${typeof actual}`)
}

function matchesPartially(actual: unknown, expected: unknown): boolean {
  try {
    assert.partialDeepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function lengthOf(actual: unknown): number | undefined {
  return (actual as { length?: number } | null | undefined)?.length
}

export function expect(actual: unknown, message?: string) {
  const build = (negate: boolean) => ({
    toBe(expected: unknown): void {
      if (negate) assert.notEqual(actual, expected, message)
      else assert.equal(actual, expected, message)
    },
    toEqual(expected: unknown): void {
      if (negate) assert.notDeepEqual(actual, expected, message)
      else assert.deepEqual(actual, expected, message)
    },
    toBeNull(): void {
      if (negate) assert.notEqual(actual, null, message)
      else assert.equal(actual, null, message)
    },
    toBeTruthy(): void {
      if (negate) assert.ok(!actual, message)
      else assert.ok(actual, message)
    },
    toBeUndefined(): void {
      if (negate) assert.notEqual(actual, undefined, message)
      else assert.equal(actual, undefined, message)
    },
    toContain(expected: unknown): void {
      const hit = includes(actual, expected)
      if (negate) assert.ok(!hit, message)
      else assert.ok(hit, message)
    },
    toHaveLength(expected: number): void {
      const length = lengthOf(actual)
      if (negate) assert.notEqual(length, expected, message)
      else assert.equal(length, expected, message)
    },
    toMatchObject(expected: unknown): void {
      const hit = matchesPartially(actual, expected)
      if (negate) assert.ok(!hit, message)
      else assert.ok(hit, message)
    },
  })
  return { ...build(false), not: build(true) }
}
