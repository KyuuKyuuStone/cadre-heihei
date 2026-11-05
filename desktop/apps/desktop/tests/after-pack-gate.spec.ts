import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertObjectKeyDeclaredOnce, countObjectKeyDeclarations, createAfterPackGate, type AfterPackGateDeps } from '../scripts/after-pack-gate.mjs'

const FACTORY_SOURCE = readFileSync(fileURLToPath(new URL('../scripts/electron-builder-config.mjs', import.meta.url)), 'utf8')
const SECRET_LINE = 'const apiKey = "sk-abcdefghijklmnopqrstuvwx123456"'

/** Red fixture mirroring the historical defect: two hooks, one object literal. */
const DUPLICATED_HOOK_SOURCE = [
  'export default {',
  "  appId: 'com.example',",
  '  afterPack: async context => {',
  '    // first hook (the one the builder silently dropped)',
  '  },',
  '  afterPack: async context => {',
  '    // second hook (the only one that ran)',
  '  },',
  '}',
  '',
].join('\n')

const SINGLE_HOOK_SOURCE = [
  'export default {',
  "  appId: 'com.example',",
  '  afterPack: createAfterPackGate({}),',
  '}',
  '',
].join('\n')

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'after-pack-gate-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Build a minimal asar the scanner's own reader can parse: header ints, the
 * JSON file tree at offset 16, payload at dataBase = 8 + headerSize.
 */
function buildAsar(files: Record<string, { offset: string, size: number }>, payload = Buffer.alloc(0)): Buffer {
  const tree = JSON.stringify({ files })
  const json = Buffer.from(tree, 'utf8')
  const headerSize = 8 + json.length
  const dataBase = 8 + headerSize
  const buffer = Buffer.alloc(dataBase + payload.length)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(headerSize, 4)
  buffer.writeUInt32LE(headerSize, 8)
  buffer.writeUInt32LE(json.length, 12)
  json.copy(buffer, 16)
  payload.copy(buffer, dataBase)
  return buffer
}

function recordingDeps(overrides: Partial<AfterPackGateDeps> = {}): { deps: AfterPackGateDeps, calls: string[], logLines: string[] } {
  const calls: string[] = []
  const logLines: string[] = []
  const log = {
    error: (...values: unknown[]) => { logLines.push(values.map(String).join(' ')) },
    info: (...values: unknown[]) => { logLines.push(values.map(String).join(' ')) },
  }
  const deps: AfterPackGateDeps = {
    verifyDesktopRuntime: async () => { calls.push('verify-runtime') },
    runtimeRoot: 'runtime-root',
    expectedRuntimeVersion: '1.5.0',
    platform: 'win32',
    arch: 'x64',
    log,
    ...overrides,
  }
  return { deps, calls, logLines }
}

describe('electron-builder config factory hook guard', () => {
  it('red: a duplicated hook key is rejected — the shape that silently dropped the secrets scan', () => {
    expect(countObjectKeyDeclarations(DUPLICATED_HOOK_SOURCE, 'afterPack')).toBe(2)
    expect(() => assertObjectKeyDeclaredOnce(DUPLICATED_HOOK_SOURCE, 'afterPack', 'factory.mjs'))
      .toThrow('expected exactly one afterPack declaration, found 2')
  })

  it('red: a missing hook key is rejected too', () => {
    expect(countObjectKeyDeclarations(SINGLE_HOOK_SOURCE.replace('  afterPack: createAfterPackGate({}),\n', ''), 'afterPack')).toBe(0)
    expect(() => assertObjectKeyDeclaredOnce('export default {}\n', 'afterPack', 'factory.mjs'))
      .toThrow('found 0')
  })

  it('green: a single declaration passes', () => {
    expect(countObjectKeyDeclarations(SINGLE_HOOK_SOURCE, 'afterPack')).toBe(1)
    expect(() => assertObjectKeyDeclaredOnce(SINGLE_HOOK_SOURCE, 'afterPack', 'factory.mjs')).not.toThrow()
  })

  it('the real config factory declares afterPack exactly once (regression pin)', () => {
    expect(countObjectKeyDeclarations(FACTORY_SOURCE, 'afterPack')).toBe(1)
    expect(() => assertObjectKeyDeclaredOnce(FACTORY_SOURCE, 'afterPack', 'electron-builder-config.mjs')).not.toThrow()
  })
})

describe('afterPack gate', () => {
  it('green: a clean tree passes the scan and then verifies the packaged runtime', async () => {
    await withDirectory(async (appOutDir) => {
      const resourcesDir = join(appOutDir, 'resources')
      await mkdir(resourcesDir, { recursive: true })
      await writeFile(join(resourcesDir, 'main.js'), "console.log('ok')\n")
      await writeFile(join(resourcesDir, 'app.asar'), buildAsar({}))
      const { deps, calls, logLines } = recordingDeps()
      const hook = createAfterPackGate(deps)
      await expect(hook({ appOutDir, packager: { getResourcesDir: () => resourcesDir } })).resolves.toBeUndefined()
      expect(logLines.some((line) => line.includes('check-no-secrets] PASS'))).toBe(true)
      expect(calls).toEqual(['verify-runtime'])
    })
  })

  it('red: a secret-like file in resources aborts packaging before runtime verification runs', async () => {
    await withDirectory(async (appOutDir) => {
      const resourcesDir = join(appOutDir, 'resources')
      await mkdir(resourcesDir, { recursive: true })
      await writeFile(join(resourcesDir, 'settings.txt'), `${SECRET_LINE}\n`)
      await writeFile(join(resourcesDir, 'app.asar'), buildAsar({}))
      const { deps, calls } = recordingDeps()
      const hook = createAfterPackGate(deps)
      await expect(hook({ appOutDir, packager: { getResourcesDir: () => resourcesDir } }))
        .rejects.toThrow('check-no-secrets: 1 secret-like hit(s)')
      expect(calls).toEqual([])
    })
  })

  it('red: a secret inside app.asar is caught — the face the duplicate key had disabled', async () => {
    await withDirectory(async (appOutDir) => {
      const resourcesDir = join(appOutDir, 'resources')
      await mkdir(resourcesDir, { recursive: true })
      const payload = Buffer.from(`${SECRET_LINE}\n`, 'utf8')
      await writeFile(join(resourcesDir, 'app.asar'), buildAsar({ 'docs/notes.txt': { offset: '0', size: payload.length } }, payload))
      const { deps, calls } = recordingDeps()
      const hook = createAfterPackGate(deps)
      await expect(hook({ appOutDir, packager: { getResourcesDir: () => resourcesDir } }))
        .rejects.toThrow('check-no-secrets')
      expect(calls).toEqual([])
    })
  })

  it('red: a runtime verification failure also terminates (any failure aborts packaging)', async () => {
    await withDirectory(async (appOutDir) => {
      const resourcesDir = join(appOutDir, 'resources')
      await mkdir(resourcesDir, { recursive: true })
      await writeFile(join(resourcesDir, 'app.asar'), buildAsar({}))
      const { deps } = recordingDeps({
        verifyDesktopRuntime: async () => { throw new Error('runtime tree mismatch') },
      })
      const hook = createAfterPackGate(deps)
      await expect(hook({ appOutDir, packager: { getResourcesDir: () => resourcesDir } }))
        .rejects.toThrow('runtime tree mismatch')
    })
  })

  it('hands the right operands to the runtime verification and the windows unpack check', async () => {
    await withDirectory(async (appOutDir) => {
      const resourcesDir = join(appOutDir, 'resources')
      await mkdir(resourcesDir, { recursive: true })
      await writeFile(join(resourcesDir, 'app.asar'), buildAsar({}))
      const seen: string[] = []
      const { deps } = recordingDeps({
        verifyDesktopRuntime: async (runtimeRoot, version, options) => {
          seen.push(`runtime:${runtimeRoot}:${version}:${options.platform}/${options.arch}`)
        },
        verifyWindowsAsarUnpack: async (runtimeRoot, dir, code) => {
          seen.push(`unpack:${runtimeRoot}:${dir}:${String(code)}`)
        },
        getWindowsCode: () => ['prepared'],
      })
      const hook = createAfterPackGate(deps)
      await hook({ appOutDir, packager: { getResourcesDir: () => resourcesDir } })
      expect(seen).toEqual([
        'runtime:runtime-root:1.5.0:win32/x64',
        `unpack:runtime-root:${resourcesDir}:prepared`,
      ])
    })
  })
})
