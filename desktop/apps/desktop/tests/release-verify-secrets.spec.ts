import { describe, expect, it } from 'vitest'
import { findSecretLikeKeys } from '../scripts/release.mjs'

describe('release verify secret-key heuristic', () => {
  it('green: documentation anchors that merely spell sk- inside a word are not keys', () => {
    // The 1.5.1 false positive: ws README's Node docs anchor for http.websocketMask().
    const wsAnchor = '[`http.websocketMask()`]:\n  https://nodejs.org/api/http.html#httpwebsocketmasksource-mask-output-offset-length\n'
    expect(findSecretLikeKeys(wsAnchor)).toEqual([])
    // Word-internal suffixes in either case stay non-hits.
    expect(findSecretLikeKeys('mask-output-offset-length tasks-output-x')).toEqual([])
  })

  it('red: standalone API-key tokens still fail the gate', () => {
    expect(findSecretLikeKeys('const key = "sk-abcdefghijklmnopqrstuvwx123456"')).toEqual(['sk-abcdefghijklmnopqrstuvwx123456'])
    expect(findSecretLikeKeys('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345')).toEqual(['sk-proj-abcdefghijklmnopqrstuvwxyz012345'])
    expect(findSecretLikeKeys('`sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`')).toEqual(['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'])
  })

  it('red: keys are still caught after arbitrary safe prose around them', () => {
    const doc = `See ${'https://nodejs.org/api/http.html#httpwebsocketmasksource-mask-output-offset-length'} for mask docs.\nkey: sk-live-abcdefghijklmnopqrstuvwxyz123456\n`
    expect(findSecretLikeKeys(doc)).toEqual(['sk-live-abcdefghijklmnopqrstuvwxyz123456'])
  })

  it('keeps the 20-character minimum: short sk- tokens are not keys', () => {
    expect(findSecretLikeKeys('sk-short')).toEqual([])
    expect(findSecretLikeKeys('"sk-1234567890123456789"')).toEqual([])
  })
})
