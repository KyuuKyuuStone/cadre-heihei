import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, afterEach, describe, expect, it, vi } from 'vitest'
import {
  CADRE_RELEASES_URL,
  GitHubUpdateService,
  checkLatestRelease,
  compareVersions,
  isNewerVersion,
  parseVersion,
} from '../src/github-update.ts'
import { readDesktopSettings, writeDesktopSettings } from '../src/settings.ts'

function fixture(): string {
  const userData = mkdtempSync(join(tmpdir(), 'cadre-update-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  return userData
}

describe('semantic version comparison', () => {
  it('compares each numeric component, not the string', () => {
    expect(isNewerVersion('0.9.10', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.99')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.9.9', '0.9.10')).toBe(false)
  })

  it('accepts a v prefix and ignores build metadata', () => {
    expect(parseVersion('v0.9.1')).toEqual({ core: [0, 9, 1], prerelease: [] })
    expect(compareVersions('v0.9.1', '0.9.1')).toBe(0)
    expect(compareVersions('0.9.1+build.7', '0.9.1')).toBe(0)
  })

  it('orders prereleases below the release and compares identifiers per SemVer', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('never treats an invalid version as newer', () => {
    expect(parseVersion('v0.9')).toBeNull()
    expect(isNewerVersion('not-a-version', '0.9.0')).toBe(false)
  })
})

describe('GitHub release check', () => {
  const latest = (tag: unknown) => vi.fn(async () => new Response(
    JSON.stringify({ tag_name: tag }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch

  it('returns available for a newer tag', async () => {
    await expect(checkLatestRelease({ currentVersion: '0.9.0', fetchImpl: latest('v0.9.10') }))
      .resolves.toEqual({ kind: 'available', version: '0.9.10' })
  })

  it('returns current for the same version', async () => {
    await expect(checkLatestRelease({ currentVersion: '0.9.1', fetchImpl: latest('v0.9.1') }))
      .resolves.toEqual({ kind: 'current', version: '0.9.1' })
  })

  it('silently skips a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch
    await expect(checkLatestRelease({ currentVersion: '0.9.0', fetchImpl }))
      .resolves.toEqual({ kind: 'skipped', reason: 'response' })
  })

  it('silently skips a malformed tag', async () => {
    await expect(checkLatestRelease({ currentVersion: '0.9.0', fetchImpl: latest('release-latest') }))
      .resolves.toEqual({ kind: 'skipped', reason: 'invalid' })
  })

  it('silently skips network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    await expect(checkLatestRelease({ currentVersion: '0.9.0', fetchImpl }))
      .resolves.toEqual({ kind: 'skipped', reason: 'network' })
  })

  it('aborts after the short timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    })) as unknown as typeof fetch
    await expect(checkLatestRelease({ currentVersion: '0.9.0', fetchImpl, timeoutMs: 5 }))
      .resolves.toEqual({ kind: 'skipped', reason: 'timeout' })
  })

  it('uses the public releases page, never a response-supplied URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ tag_name: 'v0.9.10', html_url: 'https://evil.example/download' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const result = await checkLatestRelease({ currentVersion: '0.9.0', fetchImpl })
    expect(result).toEqual({ kind: 'available', version: '0.9.10' })
    expect(CADRE_RELEASES_URL).toBe('https://github.com/KyuuKyuuStone/cadre-heihei/releases/latest')
  })
})

describe('GitHub update service', () => {
  afterEach(() => { vi.useRealTimers() })

  it('checks at startup, publishes a notice, and dismisses it', async () => {
    const userData = fixture()
    const publish = vi.fn()
    const checkRelease = vi.fn(async () => ({ kind: 'available' as const, version: '0.9.1' }))
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.0', hasTeamData: () => false, publish, checkRelease,
    })
    service.start()
    await service.check()
    expect(publish).toHaveBeenLastCalledWith({
      kind: 'available', version: '0.9.1', url: CADRE_RELEASES_URL,
    })
    expect(service.notice).toEqual({ kind: 'available', version: '0.9.1', url: CADRE_RELEASES_URL })
    service.dismiss('available')
    expect(service.notice).toBeNull()
    expect(publish).toHaveBeenLastCalledWith(null)
    service.stop()
  })

  it('shows the one-time upgrade notice when data survives a version change', () => {
    const userData = fixture()
    writeDesktopSettings(userData, { checkForUpdates: false, lastSeenVersion: '0.9.0' })
    const publish = vi.fn()
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.1', hasTeamData: () => true, publish,
    })
    service.start()
    expect(publish).toHaveBeenLastCalledWith({
      kind: 'upgraded', version: '0.9.1', fromVersion: '0.9.0',
    })
    expect(readDesktopSettings(userData).updates.lastSeenVersion).toBe('0.9.1')
    service.stop()
  })

  it('treats an existing team with no version marker as an upgrade once', () => {
    const userData = fixture()
    writeDesktopSettings(userData, { checkForUpdates: false })
    const publish = vi.fn()
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.1', hasTeamData: () => true, publish,
    })
    service.start()
    expect(publish).toHaveBeenLastCalledWith({ kind: 'upgraded', version: '0.9.1' })
    service.stop()
  })

  it('does not show an upgrade notice on a fresh install', () => {
    const userData = fixture()
    writeDesktopSettings(userData, { checkForUpdates: false })
    const publish = vi.fn()
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.1', hasTeamData: () => false, publish,
    })
    service.start()
    expect(publish).not.toHaveBeenCalled()
    expect(readDesktopSettings(userData).updates.lastSeenVersion).toBe('0.9.1')
    service.stop()
  })

  it('turns the network off completely and checks immediately when re-enabled', async () => {
    const userData = fixture()
    const checkRelease = vi.fn(async () => ({ kind: 'available' as const, version: '0.9.1' }))
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.0', hasTeamData: () => false, publish: vi.fn(), checkRelease,
    })
    service.start()
    await service.check()
    const afterStartup = checkRelease.mock.calls.length
    await service.setEnabled(false)
    expect(service.enabled).toBe(false)
    await service.check()
    expect(checkRelease).toHaveBeenCalledTimes(afterStartup)
    await service.setEnabled(true)
    expect(service.enabled).toBe(true)
    expect(checkRelease.mock.calls.length).toBeGreaterThan(afterStartup)
    service.stop()
  })

  it('rechecks on the daily interval', async () => {
    vi.useFakeTimers()
    const userData = fixture()
    const checkRelease = vi.fn(async () => ({ kind: 'current' as const, version: '0.9.0' }))
    const service = new GitHubUpdateService({
      userData, currentVersion: '0.9.0', hasTeamData: () => false, publish: vi.fn(), checkRelease, intervalMs: 1_000,
    })
    service.start()
    await service.check()
    expect(checkRelease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(checkRelease).toHaveBeenCalledTimes(2)
    service.stop()
  })
})
