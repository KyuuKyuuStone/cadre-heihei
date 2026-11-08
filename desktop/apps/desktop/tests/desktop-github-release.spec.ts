import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  desktopGithubRelease,
  resolveDesktopGithubReleasePlan,
  verifyDesktopGithubReleaseIdentity,
  type DesktopGithubReleasePlan,
  type GhResult,
} from '../scripts/desktop-github-release.ts'

const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const VERSION = '1.5.4'
const TAG = `v${VERSION}`
const REPOSITORY = 'KyuuKyuuStone/cadre-heihei'
const INSTALLER_NAME = `cadre-heihei-${VERSION}-win-x64-unsigned.exe`

interface Fixture {
  readonly root: string
  readonly installer: string
  readonly notes: string
}

const fixtures: string[] = []

function setupArtifacts(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-github-release-'))
  fixtures.push(root)
  const installer = join(root, INSTALLER_NAME)
  writeFileSync(installer, 'installer bytes')
  writeFileSync(`${installer}.blockmap`, 'blockmap bytes')
  writeFileSync(
    join(root, 'win-x64-release.json'),
    JSON.stringify({ schemaVersion: 1, target: 'win-x64', version: VERSION, commit: COMMIT, dirty: false }),
  )
  const notes = join(root, 'notes.md')
  writeFileSync(notes, `# ${VERSION} notes`)
  return { root, installer, notes }
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true })
})

function planFrom(fixture: Fixture): DesktopGithubReleasePlan {
  return resolveDesktopGithubReleasePlan([fixture.installer], fixture.notes, null, REPOSITORY)
}

/**
 * Scripted gh: each call returns a matcher answer or fails loud, so a test
 * that reaches a write proves which reads gated it.
 */
function fakeGh(
  respond: (args: readonly string[]) => string | Error | undefined,
): {
  readonly run: (args: readonly string[]) => GhResult
  readonly calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    run: args => {
      calls.push([...args])
      const response = respond(args)
      if (response instanceof Error) return { status: 1, stdout: '', stderr: response.message }
      if (response === undefined) return { status: 1, stdout: '', stderr: `fakeGh: unscripted call ${args.join(' ')}` }
      return { status: 0, stdout: response, stderr: '' }
    },
  }
}

function releaseViewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tagName: TAG,
    isDraft: false,
    isPrerelease: true,
    targetCommitish: COMMIT,
    assets: [],
    url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
    ...overrides,
  })
}

/**
 * Commit present, tag names the commit, scripted release views; create and
 * upload succeed, and later views reflect whatever this fake uploaded.
 */
function identityGh(
  releaseViews: readonly (string | Error)[],
  tagObject: { sha: string, type: string } = { sha: COMMIT, type: 'commit' },
): ReturnType<typeof fakeGh> {
  let views = 0
  const uploaded: { name: string, size: number, state: string }[] = []
  return fakeGh(args => {
    if (args[0] === 'api' && args[1]?.includes('/commits/')) return ''
    if (args[0] === 'api' && args[1]?.includes('/git/ref/tags/')) return JSON.stringify({ object: tagObject })
    if (args[0] === 'release' && args[1] === 'view') {
      const response = releaseViews[Math.min(views, releaseViews.length - 1)]
      views += 1
      if (response === undefined) return undefined
      if (response instanceof Error) return response
      const view = JSON.parse(response) as { assets?: unknown[] }
      return JSON.stringify({ ...JSON.parse(response), assets: (view.assets ?? []).length > 0 ? view.assets : uploaded })
    }
    if (args[0] === 'release' && args[1] === 'create') return ''
    if (args[0] === 'release' && args[1] === 'upload') {
      for (const path of args.slice(args.indexOf('--repo') + 2)) {
        if (typeof path === 'string') uploaded.push({ name: basename(path), size: statSync(path).size, state: 'uploaded' })
      }
      return ''
    }
    return undefined
  })
}

describe('desktop github release plan', () => {
  it('builds a plan from the installer and its completion record, adding the adjacent blockmap', () => {
    const fixture = setupArtifacts()
    const plan = planFrom(fixture)
    expect(plan).toMatchObject({
      repository: REPOSITORY,
      target: 'win-x64',
      version: VERSION,
      commit: COMMIT,
      tag: TAG,
      title: `Cadre Heihei ${VERSION}`,
      prerelease: true,
    })
    expect(plan.assets.map(asset => asset.name)).toEqual([INSTALLER_NAME, `${INSTALLER_NAME}.blockmap`])
  })

  it('refuses a dirty build because the tag would not name the tree users received', () => {
    const fixture = setupArtifacts()
    writeFileSync(
      join(fixture.root, 'win-x64-release.json'),
      JSON.stringify({ schemaVersion: 1, target: 'win-x64', version: VERSION, commit: COMMIT, dirty: true }),
    )
    expect(() => planFrom(fixture)).toThrow(/with uncommitted changes.*rebuild from a clean checkout/s)
  })

  it('refuses an installer whose version disagrees with the completion record', () => {
    const fixture = setupArtifacts()
    const staleInstaller = join(fixture.root, 'cadre-heihei-1.5.5-win-x64-unsigned.exe')
    writeFileSync(staleInstaller, 'stale bytes')
    expect(() => resolveDesktopGithubReleasePlan([staleInstaller], fixture.notes, null, REPOSITORY))
      .toThrow(/names version 1\.5\.5 but the completion record names 1\.5\.4/)
  })

  it('refuses a missing completion record without touching the network', () => {
    const fixture = setupArtifacts()
    rmSync(join(fixture.root, 'win-x64-release.json'))
    const { run, calls } = fakeGh(() => undefined)
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no completion record at .*win-x64-release\.json/)
    expect(calls).toEqual([])
  })

  it('requires release notes', () => {
    const fixture = setupArtifacts()
    const result = desktopGithubRelease([fixture.installer], { run: fakeGh(() => undefined).run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('--notes-file is required')
  })

  it('plans a full release with the latest flag and keeps the prerelease default', () => {
    const fixture = setupArtifacts()
    const latestPlan = resolveDesktopGithubReleasePlan([fixture.installer], fixture.notes, null, REPOSITORY, false)
    expect(latestPlan.prerelease).toBe(false)
    expect(planFrom(fixture).prerelease).toBe(true)
  })
})

describe('desktop github release identity', () => {
  it('accepts the absent-tag absent-release path and reports a fresh publish', () => {
    const plan = planFrom(setupArtifacts())
    const { run, calls } = identityGh([new Error(`release ${TAG} not found`)])
    expect(verifyDesktopGithubReleaseIdentity(plan, run)).toEqual({ releaseExisted: false })
    expect(calls.map(call => call.slice(0, 2))).toEqual([
      ['api', `repos/${REPOSITORY}/commits/${COMMIT}`],
      ['api', `repos/${REPOSITORY}/git/ref/tags/${TAG}`],
      ['release', 'view'],
    ])
  })

  it('accepts a lightweight tag and an empty release that both name the packaged commit', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = identityGh([releaseViewJson()])
    expect(verifyDesktopGithubReleaseIdentity(plan, run)).toEqual({ releaseExisted: true })
  })

  it('refuses a tag that names another commit', () => {
    const plan = planFrom(setupArtifacts())
    const { run, calls } = identityGh([releaseViewJson()], { sha: OTHER, type: 'commit' })
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(`tag ${TAG} names ${OTHER}, not the packaged commit ${COMMIT}`)
    expect(calls.some(call => call[0] === 'release')).toBe(false)
  })

  it('refuses an annotated tag instead of peeling it', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = identityGh([releaseViewJson()], { sha: OTHER, type: 'tag' })
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run)).toThrow(/annotated tag/)
  })

  it('refuses a release that targets another commit, the v1.5.3 mismatch', () => {
    const plan = planFrom(setupArtifacts())
    const { run, calls } = identityGh([releaseViewJson({ targetCommitish: OTHER })])
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(`release ${TAG} targets ${OTHER}, not the packaged commit ${COMMIT}`)
    expect(calls.some(call => call.includes('upload'))).toBe(false)
  })

  it('refuses a release that already carries assets, the double-operation case', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = identityGh([releaseViewJson({
      assets: [{ name: 'cadre-heihei-1.5.3-win-x64-unsigned.exe', size: 288172253, state: 'uploaded' }],
    })])
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(/already carries 1 asset\(s\): cadre-heihei-1\.5\.3-win-x64-unsigned\.exe/)
  })

  it('refuses a draft release left by another operator', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = identityGh([releaseViewJson({ isDraft: true })])
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run)).toThrow(/is a draft/)
  })

  it('refuses to resume a full release when publishing a prerelease', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = identityGh([releaseViewJson({ isPrerelease: false })])
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(/is not marked prerelease, but this run publishes a prerelease/)
  })

  it('refuses to resume a prerelease-marked release when publishing with --latest', () => {
    const fixture = setupArtifacts()
    const plan = resolveDesktopGithubReleasePlan([fixture.installer], fixture.notes, null, REPOSITORY, false)
    const { run } = identityGh([releaseViewJson()])
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(/is marked prerelease, but this run publishes a full release/)
  })

  it('refuses a packaged commit that is not on the remote', () => {
    const plan = planFrom(setupArtifacts())
    const { run } = fakeGh(args => (args[0] === 'api' && args[1]?.includes('/commits/') ? new Error('HTTP 404: Not Found') : undefined))
    expect(() => verifyDesktopGithubReleaseIdentity(plan, run))
      .toThrow(`packaged commit ${COMMIT.slice(0, 12)} is not on ${REPOSITORY}`)
  })
})

describe('desktop github release publish', () => {
  it('creates the release with the packaged commit as target and uploads without clobbering', () => {
    const fixture = setupArtifacts()
    const { run, calls } = identityGh([new Error(`release ${TAG} not found`), releaseViewJson()])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(true)
    expect(result.message).toContain(`published ${TAG} at`)
    const create = calls.find(call => call.includes('create'))
    expect(create).toBeDefined()
    const targetIndex = create?.indexOf('--target') ?? -1
    expect(targetIndex).toBeGreaterThan(-1)
    expect(create?.[targetIndex + 1]).toBe(COMMIT)
    expect(create).toContain('--prerelease')
    const upload = calls.find(call => call.includes('upload'))
    expect(upload?.some(argument => typeof argument === 'string' && argument.includes('blockmap'))).toBe(true)
    expect(calls.filter(call => call.includes('--clobber'))).toEqual([])
  })

  it('resumes an existing empty release without creating a second one', () => {
    const fixture = setupArtifacts()
    const { run, calls } = identityGh([releaseViewJson(), releaseViewJson()])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(true)
    expect(calls.some(call => call.includes('create'))).toBe(false)
    expect(calls.some(call => call.includes('upload'))).toBe(true)
  })

  it('publishes a full release with --latest: the create call carries no --prerelease flag', () => {
    const fixture = setupArtifacts()
    const { run, calls } = identityGh([
      new Error(`release ${TAG} not found`),
      releaseViewJson({ isPrerelease: false }),
    ])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes, '--latest'], { run })
    expect(result.ok).toBe(true)
    const create = calls.find(call => call.includes('create'))
    expect(create).toBeDefined()
    expect(create).not.toContain('--prerelease')
    expect(create?.includes('--title')).toBe(true)
  })

  it('fails when the published release no longer names the packaged commit', () => {
    const fixture = setupArtifacts()
    const { run } = identityGh([new Error(`release ${TAG} not found`), releaseViewJson({ targetCommitish: OTHER })])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(`verification failed: release ${TAG} targets ${OTHER}, expected ${COMMIT}`)
  })

  it('fails verification when an uploaded asset is missing from the release', () => {
    const fixture = setupArtifacts()
    const { run } = identityGh([
      new Error(`release ${TAG} not found`),
      releaseViewJson({ assets: [{ name: 'something-else.exe', size: 1, state: 'uploaded' }] }),
    ])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(`asset ${INSTALLER_NAME} is not on the release`)
  })

  it('fails verification when the remote digest disagrees with the local file', () => {
    const fixture = setupArtifacts()
    const { run } = identityGh([
      new Error(`release ${TAG} not found`),
      releaseViewJson({ assets: [{ name: INSTALLER_NAME, size: 15, state: 'uploaded', digest: 'sha256:deadbeef' }] }),
    ])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/digest sha256:deadbeef does not match the local file sha256:[0-9a-f]{64}/)
  })

  it('supports a dry run: full identity checks, no writes', () => {
    const fixture = setupArtifacts()
    const { run, calls } = identityGh([new Error(`release ${TAG} not found`)])
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes, '--dry-run'], { run })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('dry run')
    expect(calls.some(call => call.includes('create'))).toBe(false)
    expect(calls.some(call => call.includes('upload'))).toBe(false)
  })

  it('reports an upload failure with the reconcile hint', () => {
    const fixture = setupArtifacts()
    const { run } = fakeGh(args => {
      if (args[0] === 'api' && args[1]?.includes('/commits/')) return ''
      if (args[0] === 'api' && args[1]?.includes('/git/ref/tags/')) return JSON.stringify({ object: { sha: COMMIT, type: 'commit' } })
      if (args[0] === 'release' && args[1] === 'view') return new Error(`release ${TAG} not found`)
      if (args[0] === 'release' && args[1] === 'upload') return new Error('asset under the same name already exists')
      if (args[0] === 'release' && args[1] === 'create') return ''
      return undefined
    })
    const result = desktopGithubRelease([fixture.installer, '--notes-file', fixture.notes], { run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('gh release upload')
    expect(result.message).toContain('partial assets')
  })
})

describe('desktop github release argument handling', () => {
  it('rejects unknown options', () => {
    const result = desktopGithubRelease(['installer.exe', '--notes-file', 'n.md', '--clobber'], { run: fakeGh(() => undefined).run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('unknown option --clobber')
  })

  it('rejects a repository that is not owner/name', () => {
    const fixture = setupArtifacts()
    const result = desktopGithubRelease(
      [fixture.installer, '--notes-file', fixture.notes, '--repository', 'not-a-repo'],
      { run: fakeGh(() => undefined).run },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not owner/name')
  })
})
