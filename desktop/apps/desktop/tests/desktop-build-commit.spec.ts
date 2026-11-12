import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CADRE_SOURCE_COMMIT_ENV,
  CLIENT_BUILD_COMMIT_ENV,
  DESKTOP_BUILD_COMMIT_ENV,
  DESKTOP_BUILD_DIRTY_ENV,
  UNKNOWN_DESKTOP_BUILD_COMMIT,
  desktopBuildCommitEnvironment,
  readDesktopBuildCommit,
  resolveDesktopBuildCommit,
} from '../scripts/desktop-build-commit.mjs'
import { probeDesktopToolchain } from '../scripts/desktop-toolchain-preflight.ts'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const directories: string[] = []

// Ambient Git variables would make `git rev-parse` succeed against some other
// repository, and a machine-set CADRE_SOURCE_COMMIT would change the fallback,
// so the fallback tests pin both for their duration.
const gitEnvironmentNames = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const
const inFallbackEnvironment = (override: string | undefined, run: () => void): void => {
  const savedCommit = process.env[CADRE_SOURCE_COMMIT_ENV]
  const savedGit = gitEnvironmentNames.map(name => [name, process.env[name]] as const)
  if (override === undefined) delete process.env[CADRE_SOURCE_COMMIT_ENV]
  else process.env[CADRE_SOURCE_COMMIT_ENV] = override
  for (const name of gitEnvironmentNames) delete process.env[name]
  try { run() } finally {
    if (savedCommit === undefined) delete process.env[CADRE_SOURCE_COMMIT_ENV]
    else process.env[CADRE_SOURCE_COMMIT_ENV] = savedCommit
    for (const [name, value] of savedGit) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const temporaryTree = async (prefix: string): Promise<string> => {
  const tree = await mkdtemp(join(tmpdir(), prefix))
  directories.push(tree)
  return tree
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('desktop build commit', () => {
  it('reads nothing outside a packaging run', () => {
    expect(resolveDesktopBuildCommit({})).toBeUndefined()
    expect(resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: '  ' })).toBeUndefined()
  })

  it('round-trips a commit and its tree state through a child environment', () => {
    for (const dirty of [true, false]) {
      expect(resolveDesktopBuildCommit(desktopBuildCommitEnvironment({ commit: COMMIT, dirty })))
        .toEqual({ commit: COMMIT, dirty })
    }
  })

  it.each(['abc', `${COMMIT}0`, 'Z'.repeat(40)])('rejects %j, which is not a commit hash', (commit) => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: commit })).toThrow(/must be a commit hash/u)
  })

  it('rejects a tree state that is neither 0 nor 1', () => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: COMMIT, [DESKTOP_BUILD_DIRTY_ENV]: 'yes' }))
      .toThrow(/must be 0 or 1/u)
  })

  it('reads the checkout this repository is in', () => {
    const packaged = readDesktopBuildCommit(join(import.meta.dirname, '..', '..', '..'))
    expect(packaged.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(typeof packaged.dirty).toBe('boolean')
  })

  it('round-trips the unknown fallback commit through a child environment', () => {
    for (const dirty of [true, false]) {
      expect(resolveDesktopBuildCommit(desktopBuildCommitEnvironment({ commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty })))
        .toEqual({ commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty })
    }
  })

  it('falls back to unknown with a warning outside a Git repository', async () => {
    const tree = await temporaryTree('dsh-no-git-')
    inFallbackEnvironment(undefined, () => {
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      let warning = ''
      try {
        expect(readDesktopBuildCommit(tree)).toEqual({ commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty: false })
        warning = warn.mock.calls.map(call => String(call[0])).join('')
      } finally { warn.mockRestore() }
      expect(warning).toContain(CADRE_SOURCE_COMMIT_ENV)
    })
  })

  it('falls back to unknown in a repository without commits', async () => {
    const tree = await temporaryTree('dsh-unborn-')
    execFileSync('git', ['init', tree], { stdio: 'ignore' })
    inFallbackEnvironment(undefined, () => {
      expect(readDesktopBuildCommit(tree)).toEqual({ commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty: false })
    })
  })

  it('reads CADRE_SOURCE_COMMIT outside a Git repository, for local and release builds alike', async () => {
    const tree = await temporaryTree('dsh-no-git-')
    inFallbackEnvironment(COMMIT, () => {
      expect(readDesktopBuildCommit(tree)).toEqual({ commit: COMMIT, dirty: false })
      expect(readDesktopBuildCommit(tree, { requireRealCommit: true })).toEqual({ commit: COMMIT, dirty: false })
    })
  })

  it('rejects a CADRE_SOURCE_COMMIT that is not a commit hash', async () => {
    const tree = await temporaryTree('dsh-no-git-')
    inFallbackEnvironment('not-a-hash', () => {
      expect(() => readDesktopBuildCommit(tree)).toThrow(/CADRE_SOURCE_COMMIT must be a commit hash/u)
    })
  })

  it('fails a release build whose only commit would be unknown', async () => {
    const tree = await temporaryTree('dsh-no-git-')
    inFallbackEnvironment(undefined, () => {
      expect(() => readDesktopBuildCommit(tree, { requireRealCommit: true })).toThrow(/real source commit/u)
    })
  })

  it('hands a real packaged commit to the client build', () => {
    expect(desktopBuildCommitEnvironment({ commit: COMMIT, dirty: true }, {}))
      .toMatchObject({ [CLIENT_BUILD_COMMIT_ENV]: COMMIT })
  })

  it('leaves a client commit the packaging environment already carries untouched', () => {
    expect(desktopBuildCommitEnvironment({ commit: COMMIT, dirty: false }, { [CLIENT_BUILD_COMMIT_ENV]: 'abc1234' }))
      .not.toHaveProperty(CLIENT_BUILD_COMMIT_ENV)
  })

  it('hands no client commit when the packaged commit is unknown', () => {
    expect(desktopBuildCommitEnvironment({ commit: UNKNOWN_DESKTOP_BUILD_COMMIT, dirty: false }, {}))
      .not.toHaveProperty(CLIENT_BUILD_COMMIT_ENV)
  })
})

describe('desktop toolchain preflight', () => {
  it('passes on a host that can read archives', async () => {
    expect(await probeDesktopToolchain('darwin', {})).toEqual([])
  })

  it('reports the archive reader when it cannot run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-no-tools-'))
    directories.push(empty)
    const saved = { PATH: process.env.PATH, Path: process.env.Path }
    try {
      Object.assign(process.env, { PATH: empty, Path: empty })
      const failures = await probeDesktopToolchain('darwin', {})
      expect(failures.map(failure => failure.tool)).toEqual(['tar'])
      expect(failures[0]?.detail).not.toBe('')
    }
    finally {
      Object.assign(process.env, saved)
    }
  })

  it('reports the Windows installer compiler when the host cannot locate Visual Studio', async () => {
    const failures = await probeDesktopToolchain('win32', {})
    expect(failures.map(failure => failure.tool)).toContain('vswhere')
    expect(failures.find(failure => failure.tool === 'vswhere')?.detail).toContain('ProgramFiles(x86)')
  })

  it('writes nothing into the working directory while probing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-probe-cwd-'))
    directories.push(directory)
    await writeFile(join(directory, 'sentinel'), '')
    await probeDesktopToolchain('darwin', {})
    expect(await import('node:fs/promises').then(async fs => fs.readdir(directory))).toEqual(['sentinel'])
  })
})
