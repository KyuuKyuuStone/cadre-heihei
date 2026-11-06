import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveDesktopAutoUpdateConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GIT_ROOT = join(APP_ROOT, '..', '..', '..')
const WINDOWS = { platform: 'win32', arch: 'x64' } as const
const MACOS = { platform: 'darwin', arch: 'arm64' } as const
const TEMPLATES = [
  { ...WINDOWS, name: '.env.windows.example' },
  { ...MACOS, name: '.env.macos.example' },
] as const

// The packaging check requires these from a test-deployment template: identity and
// deployment selection, the mandatory-update policy it embeds, and the test upload
// fields that resolveDesktopAutoUpdateConfig rejects when blank.
const REQUIRED_SHARED = [
  'DSH_DESKTOP_APP_ID',
  'DSH_DESKTOP_AUTO_UPDATE_ENV',
  'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN',
  'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG',
  'DOWNLOAD_TEST_ORIGIN',
  'DOWNLOAD_TEST_RELEASE_ID',
] as const

function insideGitRepository(): boolean {
  const version = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (version.error !== undefined || version.status !== 0) return false
  return spawnSync('git', ['-C', GIT_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status === 0
}

const IN_GIT_REPOSITORY = insideGitRepository()

function gitStatus(args: string[]): number | null {
  return spawnSync('git', ['-C', GIT_ROOT, ...args], { encoding: 'utf8' }).status
}

function repositoryPath(name: string): string {
  return relative(GIT_ROOT, join(APP_ROOT, name)).split(sep).join('/')
}

async function withTemplate(name: string, action: (appRoot: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-template-'))
  try {
    await copyFile(join(APP_ROOT, name), join(directory, name.replace('.example', '')))
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Shipped packaging templates', () => {
  it.skipIf(!IN_GIT_REPOSITORY)('stay tracked and outside every ignore rule so fresh clones receive them', () => {
    for (const { name } of TEMPLATES) {
      const path = repositoryPath(name)
      expect(gitStatus(['ls-files', '--error-unmatch', path]), `${name} must be tracked by git`).toBe(0)
      expect(gitStatus(['check-ignore', '--', path]), `${name} must not match any ignore rule`).toBe(1)
    }
  })

  it.each(TEMPLATES)('ships $name beside the packaging scripts', async ({ name }) => {
    const contents = await readFile(join(APP_ROOT, name), 'utf8')
    expect(contents.trim(), `${name} must not be empty`).not.toBe('')
  })

  it.each(TEMPLATES)('keeps every $name setting on the packaging whitelist', async ({ name, platform }) => {
    await withTemplate(name, async (appRoot) => {
      // loadDesktopPackageEnvironment throws for any file setting outside the whitelist.
      const loaded = loadDesktopPackageEnvironment(platform, {}, appRoot)
      for (const setting of REQUIRED_SHARED) {
        expect(loaded[setting], `${name} must declare ${setting}`).not.toBeUndefined()
      }
    })
  })

  it.each(TEMPLATES)('fills $name with a usable test upload origin and release id', async ({ name, platform }) => {
    await withTemplate(name, async (appRoot) => {
      const loaded = loadDesktopPackageEnvironment(platform, {}, appRoot)
      const origin = loaded.DOWNLOAD_TEST_ORIGIN ?? ''
      expect(origin.trim(), `${name} must fill DOWNLOAD_TEST_ORIGIN; blank values break fresh-clone packaging`).not.toBe('')
      expect(origin, `${name} must set DOWNLOAD_TEST_ORIGIN to an https origin`).toMatch(/^https:\/\//u)
      expect(loaded.DOWNLOAD_TEST_RELEASE_ID ?? '', `${name} must fill a 32-character lowercase hexadecimal DOWNLOAD_TEST_RELEASE_ID`)
        .toMatch(/^[a-f0-9]{32}$/u)
    })
  })

  it.each(TEMPLATES)('resolves the $platform test auto-update configuration from $name alone', async ({ name, platform, arch }) => {
    await withTemplate(name, async (appRoot) => {
      const loaded = loadDesktopPackageEnvironment(platform, {}, appRoot)
      expect(loaded.DSH_DESKTOP_AUTO_UPDATE_ENV, `${name} ships the test deployment`).toBe('test')
      expect(() => resolveDesktopAutoUpdateConfig(loaded, platform, arch)).not.toThrow()
    })
  })

  it.each(TEMPLATES)('fails signed packaging checks on machine credentials only, never on $name fields', async ({ name, platform, arch }) => {
    await withTemplate(name, async (appRoot) => {
      const loaded = loadDesktopPackageEnvironment(platform, {}, appRoot)
      let failure = ''
      try {
        validateDesktopPackageEnvironment(loaded, { platform, arch })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure, `${name} must not be the reason a signed packaging check fails`).not.toContain('DOWNLOAD_TEST_ORIGIN')
      expect(failure).not.toContain('DOWNLOAD_TEST_RELEASE_ID')
    })
  })
})
