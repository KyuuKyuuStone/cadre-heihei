import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  deriveUnsignedReleaseRecord,
  parseDeriveRecordArgs,
  type DerivedUnsignedReleaseRecord,
} from '../scripts/derive-unsigned-release-record.ts'

const COMMIT = 'c'.repeat(40)
const OTHER_COMMIT = 'd'.repeat(40)
const VERSION = '1.5.4'
const TARGET = 'win-x64'
const INSTALLER_NAME = `cadre-heihei-${VERSION}-win-x64-unsigned.exe`

interface Fixture {
  readonly root: string
  readonly artifacts: string
  readonly runs: string
}

const fixtures: string[] = []

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-derive-record-'))
  fixtures.push(root)
  const artifacts = join(root, 'targets', TARGET, 'unsigned-artifacts')
  const runs = join(root, 'packaging-runs')
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(runs, { recursive: true })
  return { root, artifacts, runs }
}

function writeRun(fixture: Fixture, name: string, startedAt: string, overrides: Record<string, unknown> = {}): string {
  const directory = join(fixture.runs, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify({
    startedAt,
    pid: 1,
    target: TARGET,
    unsigned: true,
    skipNotarization: false,
    directory: false,
    prepareOnly: false,
    version: VERSION,
    productVersion: VERSION,
    node: 'v24.19.0',
    commit: COMMIT,
    dirty: false,
    ...overrides,
  }, null, 2)}\n`)
  writeFileSync(join(directory, 'result.json'), `${JSON.stringify({
    completedAt: '2026-11-07T14:08:02.397Z',
    elapsedMs: 1000,
    success: true,
    proxy: 'not-used',
    stages: [],
  })}\n`)
  return directory
}

function writeInstaller(fixture: Fixture, overrides: { version?: string, blockmap?: boolean, content?: string } = {}): string {
  const version = overrides.version ?? VERSION
  const name = `cadre-heihei-${version}-win-x64-unsigned.exe`
  const installer = join(fixture.artifacts, name)
  writeFileSync(installer, overrides.content ?? 'installer bytes')
  if (overrides.blockmap !== false) writeFileSync(`${installer}.blockmap`, 'blockmap bytes')
  return installer
}

interface DeriveLog {
  readonly derived: DerivedUnsignedReleaseRecord
  readonly log: string[]
}

function derive(fixture: Fixture): DeriveLog {
  const log: string[] = []
  const derived = deriveUnsignedReleaseRecord({ target: TARGET, buildRoot: fixture.root, log: message => log.push(message) })
  return { derived, log }
}

function expectedRecord(commit: string): string {
  return `${JSON.stringify({ schemaVersion: 1, target: TARGET, version: VERSION, commit, dirty: false }, null, 2)}\n`
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true })
})

describe('unsigned release record derivation', () => {
  it('derives the record beside the installer from the newest run by startedAt, not by directory name', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-aaa', '2026-11-07T15:00:00.000Z', { commit: OTHER_COMMIT })
    writeRun(fixture, 'run-zzz', '2026-11-07T14:00:00.000Z', { commit: 'a'.repeat(40) })
    writeInstaller(fixture)
    const { derived, log } = derive(fixture)
    expect(derived).toMatchObject({
      recordPath: join(fixture.artifacts, 'win-x64-release.json'),
      installer: join(fixture.artifacts, INSTALLER_NAME),
      installerSize: 'installer bytes'.length,
      version: VERSION,
      commit: OTHER_COMMIT,
      runDirectory: join(fixture.runs, 'run-aaa'),
    })
    expect(readFileSync(derived.recordPath, 'utf8')).toBe(expectedRecord(OTHER_COMMIT))
    expect(log.join('\n')).toContain('run-aaa')
  })

  it('keeps an identical record untouched and leaves no temporary file', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture)
    const first = derive(fixture)
    const written = readFileSync(first.derived.recordPath, 'utf8')
    const second = derive(fixture)
    expect(second.log.join('\n')).toContain('already names')
    expect(readFileSync(first.derived.recordPath, 'utf8')).toBe(written)
    expect(existsSync(`${first.derived.recordPath}.tmp`)).toBe(false)
  })

  it('replaces a stale record when a newer run names another commit', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-old', '2026-11-07T14:00:00.000Z', { commit: 'a'.repeat(40) })
    writeInstaller(fixture)
    const first = derive(fixture)
    expect(first.derived.commit).toBe('a'.repeat(40))
    writeRun(fixture, 'run-new', '2026-11-07T15:00:00.000Z')
    const second = derive(fixture)
    expect(second.derived.commit).toBe(COMMIT)
    expect(second.log.join('\n')).toContain('replacing')
    expect(readFileSync(second.derived.recordPath, 'utf8')).toBe(expectedRecord(COMMIT))
  })

  it.each([
    ['a prepare-only run', { prepareOnly: true }, /only prepared the runtime/u],
    ['a directory-only run', { directory: true }, /bare directory/u],
    ['a dirty checkout', { dirty: true }, /dirty checkout/u],
    ['a missing version', { version: '' }, /names no version/u],
    ['a stub commit', { commit: '3d24680e' }, /full commit id/u],
  ] as const)('refuses %s', (_label: string, overrides: Record<string, unknown>, pattern: RegExp) => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z', overrides)
    writeInstaller(fixture)
    expect(() => derive(fixture)).toThrow(pattern)
  })

  it('refuses when the newest matching run is not unsigned or belongs to another target', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-signed', '2026-11-07T14:00:00.000Z', { unsigned: false })
    writeRun(fixture, 'run-mac', '2026-11-07T15:00:00.000Z', { target: 'mac-arm64' })
    writeInstaller(fixture)
    expect(() => derive(fixture)).toThrow(/no unsigned packaging run for win-x64/u)
  })

  it('refuses an unfinished run instead of falling back to an older successful one', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-old', '2026-11-07T14:00:00.000Z')
    writeRun(fixture, 'run-new', '2026-11-07T15:00:00.000Z')
    rmSync(join(fixture.runs, 'run-new', 'result.json'))
    writeInstaller(fixture)
    expect(() => derive(fixture)).toThrow(/recorded no result/u)
    expect(existsSync(join(fixture.artifacts, 'win-x64-release.json'))).toBe(false)
  })

  it('refuses a failed run', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeFileSync(join(fixture.runs, 'run-1', 'result.json'), `${JSON.stringify({ success: false })}\n`)
    writeInstaller(fixture)
    expect(() => derive(fixture)).toThrow(/did not complete successfully/u)
  })

  it('skips a broken run directory with a note and still derives from the healthy newest run', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-broken', '2026-11-07T14:30:00.000Z', { commit: 'a'.repeat(40) })
    rmSync(join(fixture.runs, 'run-broken', 'run.json'))
    writeRun(fixture, 'run-good', '2026-11-07T15:00:00.000Z')
    writeInstaller(fixture)
    const { derived, log } = derive(fixture)
    expect(derived.commit).toBe(COMMIT)
    expect(log.join('\n')).toContain('skipping run-broken')
  })

  it('refuses when the build tree has no packaging runs', () => {
    const fixture = createFixture()
    rmSync(fixture.runs, { recursive: true })
    expect(() => derive(fixture)).toThrow(/no packaging runs at/u)
  })
})

describe('unsigned installer resolution', () => {
  it('refuses when no installer names the recorded version', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture, { version: '1.5.3' })
    expect(() => derive(fixture)).toThrow(/no \.exe installer naming version 1\.5\.4/u)
  })

  it('does not match a version that merely extends the recorded one', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture, { version: '1.5.40' })
    expect(() => derive(fixture)).toThrow(/no \.exe installer naming version 1\.5\.4/u)
  })

  it('refuses two installers naming the recorded version', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture)
    writeFileSync(join(fixture.artifacts, 'other-1.5.4-win-x64-unsigned.exe'), 'installer bytes')
    writeFileSync(join(fixture.artifacts, 'other-1.5.4-win-x64-unsigned.exe.blockmap'), 'blockmap bytes')
    expect(() => derive(fixture)).toThrow(/2 \.exe installers.*keep one installer/su)
  })

  it('refuses an installer without its blockmap', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture, { blockmap: false })
    expect(() => derive(fixture)).toThrow(/\.blockmap beside the installer/u)
  })

  it('refuses an empty installer', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    writeInstaller(fixture, { content: '' })
    expect(() => derive(fixture)).toThrow(/is empty/u)
  })

  it('refuses when the unsigned artifacts directory is missing', () => {
    const fixture = createFixture()
    writeRun(fixture, 'run-1', '2026-11-07T14:00:00.000Z')
    rmSync(fixture.artifacts, { recursive: true })
    expect(() => derive(fixture)).toThrow(/no unsigned artifacts at/u)
  })
})

describe('derive record arguments', () => {
  it('parses the target and an optional build root', () => {
    expect(parseDeriveRecordArgs(['win-x64'])).toEqual({ target: 'win-x64' })
    expect(parseDeriveRecordArgs(['mac-arm64', '--build-root', 'scratch'])).toEqual({ target: 'mac-arm64', buildRoot: 'scratch' })
  })

  it('refuses missing, unknown, and duplicated arguments', () => {
    expect(() => parseDeriveRecordArgs([])).toThrow(/name one supported target/u)
    expect(() => parseDeriveRecordArgs(['linux-x64'])).toThrow(/name one supported target/u)
    expect(() => parseDeriveRecordArgs(['win-x64', '--dry-run'])).toThrow(/unknown option/u)
    expect(() => parseDeriveRecordArgs(['win-x64', 'mac-arm64'])).toThrow(/unexpected argument/u)
    expect(() => parseDeriveRecordArgs(['win-x64', '--build-root'])).toThrow(/--build-root requires a directory/u)
  })
})
