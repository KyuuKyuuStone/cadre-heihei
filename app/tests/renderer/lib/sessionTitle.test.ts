import { describe, it } from 'node:test'
import { expect } from '../assert-compat.ts'
import { deriveSessionTitle } from '../../../src/renderer/lib/sessionTitle.ts'

describe('deriveSessionTitle', () => {
  it('uses slash command metadata without showing raw XML tags', () => {
    const raw = [
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website 重新设计首页</command-args>',
    ].join('\n')

    expect(deriveSessionTitle(raw)).toBe('/frontend-design @website 重新设计首页')
  })
})
