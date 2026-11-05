import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { verifyDesktopRuntime } = vi.hoisted(() => ({
  verifyDesktopRuntime: vi.fn<(root: string, expected: string) => Promise<void>>(async () => undefined),
}))
// The hook imports the built tree, which a clean checkout has not produced; this is the path it resolves.
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime }))
vi.mock('../scripts/windows-asar-unpack.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-asar-unpack.mjs')>(),
  verifyWindowsAsarUnpack: async () => undefined,
}))

const ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.installer',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
  DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
}

// The afterPack gate scans the packaged resources before verifying the runtime,
// so the fake context points at a real temp tree whose scan comes back clean.
let fakePackRoot = ''
let fakeResourcesDir = ''

beforeEach(async () => {
  fakePackRoot = await mkdtemp(join(tmpdir(), 'packaged-runtime-'))
  fakeResourcesDir = join(fakePackRoot, 'resources')
  await mkdir(fakeResourcesDir, { recursive: true })
  await writeFile(join(fakeResourcesDir, 'app.asar'), minimalAsar())
})

afterEach(async () => {
  await rm(fakePackRoot, { recursive: true, force: true })
})

/** Minimal asar the scanner's reader parses: empty file tree, no payload. */
function minimalAsar(): Buffer {
  const json = Buffer.from('{"files":{}}', 'utf8')
  const headerSize = 8 + json.length
  const buffer = Buffer.alloc(16 + json.length)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(headerSize, 4)
  buffer.writeUInt32LE(headerSize, 8)
  buffer.writeUInt32LE(json.length, 12)
  json.copy(buffer, 16)
  return buffer
}

function fakeContext(): { appOutDir: string, packager: { getResourcesDir: () => string } } {
  return { appOutDir: fakePackRoot, packager: { getResourcesDir: () => fakeResourcesDir } }
}

/**
 * Run the packaging hook that verifies the bundled runtime.
 * @returns The version that hook required the runtime to declare.
 */
async function requiredRuntimeVersion(preparedRuntime?: string, preparedRuntimeVersion?: string): Promise<unknown> {
  verifyDesktopRuntime.mockClear()
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const config = createElectronBuilderConfig(ENVIRONMENT, 'win32', 'x64', preparedRuntime, preparedRuntimeVersion)
  await config.afterPack(fakeContext() as never)
  return verifyDesktopRuntime.mock.calls[0]?.[1]
}

describe('packaged runtime verification', () => {
  it('requires the product version when the target tree supplies the runtime', async () => {
    const productVersion = (JSON.parse(
      await import('node:fs/promises').then(async fs => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string }).version
    expect(await requiredRuntimeVersion()).toBe(productVersion)
  })

  it('requires the version installed-update qualification wrote into its private runtime', async () => {
    // Qualification rewrites the runtime's own version, so comparing against the product version would always fail.
    expect(await requiredRuntimeVersion('/qualification/dsh', '0.1.6-alpha.2.20260921.1')).toBe('0.1.6-alpha.2.20260921.1')
  })

  it('does not let a build version change what the bundled runtime must declare', async () => {
    const productVersion = (JSON.parse(
      await import('node:fs/promises').then(async fs => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string }).version
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    verifyDesktopRuntime.mockClear()
    const config = createElectronBuilderConfig(
      { ...ENVIRONMENT, DSH_DESKTOP_BUILD_VERSION: `${productVersion}.20260921.1` }, 'win32', 'x64')
    expect(config.extraMetadata).toMatchObject({ version: `${productVersion}.20260921.1` })
    await config.afterPack(fakeContext() as never)
    expect(verifyDesktopRuntime.mock.calls[0]?.[1]).toBe(productVersion)
  })
})
