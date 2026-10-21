// 新增测试（W1-10 返工）：前身仅有源码、无同名测试。
import { describe, it } from 'node:test'
import { expect } from '../assert-compat.ts'
import { cx } from '../../../src/renderer/lib/cx.ts'

describe('cx', () => {
  it('joins truthy class names with a single space', () => {
    expect(cx('a', 'b')).toBe('a b')
  })

  it('drops false, null, undefined and empty string', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('returns an empty string when nothing remains', () => {
    expect(cx(false, null, undefined)).toBe('')
  })

  it('does not deduplicate or resolve conflicting utilities', () => {
    // 文档语义：不引入 tailwind-merge，冲突类原样保留，由样式表顺序决定。
    expect(cx('px-2', 'px-4')).toBe('px-2 px-4')
  })
})
