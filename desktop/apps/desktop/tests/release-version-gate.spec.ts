import { describe, expect, it } from 'vitest'
import {
  assertVersionMonotonic,
  collectPublishedVersions,
  compareReleaseVersions,
  maxPublishedVersion,
  parseReleaseVersion,
} from '../scripts/release-version-gate.mjs'

describe('release version gate parsing', () => {
  it('accepts bare, tag-prefixed, and prerelease versions; rejects the rest', () => {
    expect(parseReleaseVersion('1.5.0')).toMatchObject({ major: 1, minor: 5, patch: 0, prerelease: undefined })
    expect(parseReleaseVersion(' v1.1.4 ')).toMatchObject({ major: 1, minor: 1, patch: 4, prerelease: undefined })
    expect(parseReleaseVersion('1.5.0-rc.1')).toMatchObject({ major: 1, minor: 5, patch: 0, prerelease: 'rc.1' })
    expect(parseReleaseVersion('weird-tag')).toBeNull()
    expect(parseReleaseVersion('README.txt')).toBeNull()
    expect(parseReleaseVersion('1.5')).toBeNull()
  })
})

describe('release version gate ordering', () => {
  it('orders numeric fields first', () => {
    expect(compareReleaseVersions('1.5.0', '1.1.4')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.1.5', '1.1.4')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.1.4', '1.1.4')).toBe(0)
    expect(compareReleaseVersions('1.0.9', '1.1.4')).toBeLessThan(0)
  })

  it('ranks a prerelease below the release it precedes', () => {
    expect(compareReleaseVersions('1.5.0-rc.1', '1.5.0')).toBeLessThan(0)
    expect(compareReleaseVersions('1.5.0', '1.5.0-rc.1')).toBeGreaterThan(0)
  })

  it('compares prerelease identifiers field by field, numerics numerically', () => {
    expect(compareReleaseVersions('1.5.0-rc.2', '1.5.0-rc.1')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.5.0-rc.10', '1.5.0-rc.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.5.0-1', '1.5.0-alpha')).toBeLessThan(0)
    expect(compareReleaseVersions('1.5.0-rc.1', '1.5.0-rc.1.1')).toBeLessThan(0)
  })

  it('refuses unparsable comparisons', () => {
    expect(() => compareReleaseVersions('abc', '1.0.0')).toThrow('cannot compare unparsable version')
    expect(() => compareReleaseVersions('1.0.0', 'abc')).toThrow('cannot compare unparsable version')
  })
})

describe('release version gate evidence collection', () => {
  it('collects tags and release directories, ignoring non-version names', () => {
    expect(collectPublishedVersions({
      tagLines: ['v1.1.4', 'v1.0.0', 'weird-tag', ''],
      releaseDirNames: ['1.1.4', 'README.txt', '0.9.3'],
    })).toEqual(['1.1.4', '1.0.0', '1.1.4', '0.9.3'])
  })

  it('defaults both sources to empty', () => {
    expect(collectPublishedVersions({})).toEqual([])
  })

  it('returns the published maximum, or null on an empty baseline', () => {
    expect(maxPublishedVersion(['1.1.4', '1.0.0', '0.9.3'])).toBe('1.1.4')
    expect(maxPublishedVersion(['1.5.0-rc.2', '1.5.0-rc.10'])).toBe('1.5.0-rc.10')
    expect(maxPublishedVersion([])).toBeNull()
  })
})

describe('release version gate decision', () => {
  it('red: refuses a target equal to the published maximum, tolerating raw tag evidence', () => {
    expect(() => assertVersionMonotonic('1.1.4', ['v1.1.4', 'v1.0.0', 'weird-tag']))
      .toThrow('not strictly higher than published max 1.1.4')
  })

  it('red: refuses a target below the published maximum', () => {
    expect(() => assertVersionMonotonic('1.0.9', ['v1.1.4'])).toThrow('not strictly higher')
    expect(() => assertVersionMonotonic('1.1.4', ['1.1.5'])).toThrow('not strictly higher')
  })

  it('red: refuses a prerelease of an already-published version', () => {
    expect(() => assertVersionMonotonic('1.5.0-rc.1', ['1.5.0'])).toThrow('not strictly higher')
  })

  it('red: refuses an unparsable target version', () => {
    expect(() => assertVersionMonotonic('next', [])).toThrow('unparsable target version')
  })

  it('green: accepts a strictly higher target over tags and directories combined', () => {
    expect(assertVersionMonotonic('1.5.0', ['v1.1.4', 'v1.0.0', '1.1.4', 'README.txt'])).toBe('1.1.4')
  })

  it('green: accepts a prerelease of a new version above an older maximum', () => {
    expect(assertVersionMonotonic('1.5.0-rc.1', ['1.1.4'])).toBe('1.1.4')
  })

  it('green: accepts any parsable target on an empty baseline', () => {
    expect(assertVersionMonotonic('0.1.0', [])).toBeNull()
  })
})
