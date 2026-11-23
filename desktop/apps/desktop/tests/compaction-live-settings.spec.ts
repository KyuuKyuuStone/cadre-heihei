import { readFile, mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Context, symbols } from '@deepseek-ai/cordis'
import {
  createRuntimeResolution,
  loadProfile,
  PluginPackages,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-compaction-basic/settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterAll, describe, expect, it } from 'vitest'
import { createPluginProfile } from '../src/project-manager.ts'

/** The product composition this seam ships in: the Web bundles plus Cadre. */
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-bundle-cadre'] as const
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PACKAGE_ROOT = join(REPO_ROOT, 'packages')
const { boot } = createRequire(import.meta.url)(join(PACKAGE_ROOT, 'boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
/** CADRE GUI rows unrelated to compaction need desktop app services this harness omits. */
const CADRE_GUI_ROWS = [
  'cadre-collab', 'cadre-governance', 'cadre-write-guard', 'cadre-supervisor-skill',
  'cadre-session-skills', 'cadre-skill-conversation', 'preset-cadre-skill-admin',
]

/** Deployment defaults live in a bundle beneath the profile patch, so Settings writes are not shadowed by ephemeral overlays. */
const DEFAULT_BUNDLE = 'dsh-compaction-test-defaults'

/** One real installation anchor declaring only the product bundles, so the closure covers their own deps. */
async function createAnchor(home: string): Promise<string> {
  const anchor = join(home, 'anchor')
  await mkdir(join(anchor, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const bundle of BUNDLES) {
    await symlink(join(PACKAGE_ROOT,
      bundle === '@deepseek-ai/dsh-base' ? 'bundle/base'
        : bundle === '@deepseek-ai/dsh-web-app' ? 'bundle/web-app' : 'bundle/cadre-app'),
    join(anchor, 'node_modules', bundle), 'junction')
  }
  const manifest = {
    name: 'cadre-heihei-desktop-test-anchor', version: '1.0.0', private: true,
    dependencies: Object.fromEntries(BUNDLES.map(bundle => [bundle, 'workspace:*'])),
  }
  await writeFile(join(anchor, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  return join(anchor, 'package.json')
}

/**
 * Boot the shipped Desktop profile through the real Loader and Host rows.
 *
 * Every bundle layer is the product's own patch file, including
 * `web-app/presets/standard.patch.yml`; only side-effect rows (ports,
 * telemetry, GUI app services) are disabled, through a deployment-default
 * bundle so a Settings write can recompose without losing them.
 */
async function bootDesktop(home: string, options: { anchor: string; userLayer: boolean }): Promise<Context> {
  const profileDir = join(home, 'profiles/desktop')
  await mkdir(profileDir, { recursive: true })
  createPluginProfile(profileDir)
  const overrides: unknown[] = [
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    { id: 'attachment-local', config: { dshHome: home } },
    { id: 'webserver', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'desktop-product-telemetry', disabled: true },
    { id: 'product-analytics', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
    ...CADRE_GUI_ROWS.map(id => ({ id, disabled: true })),
  ]
  const fixtureDir = join(profileDir, 'node_modules', DEFAULT_BUNDLE)
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({
    name: DEFAULT_BUNDLE, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(fixtureDir, 'cordis.patch.yml'), JSON.stringify(overrides))
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  if (!manifest.dsh.profile.bundles.includes(DEFAULT_BUNDLE)) {
    manifest.dsh.profile.bundles.push(DEFAULT_BUNDLE)
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  const profile: Profile = loadProfile('dsh-test', 'desktop', options.anchor, home, { userLayer: options.userLayer })
  const resolution = await createRuntimeResolution({ installAnchor: options.anchor, home, profile })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return boot('dsh-test', rootConfig, [...profile.layers.flatMap(layer => layer.patches), ...profile.patches] as never, async (bootCtx) => {
    bootCtx.provide('profileContext', {
      name: 'desktop', dir: profileDir, patchPath: profile.patchPath,
      installAnchor: options.anchor, home, cwd: home,
      startedBundles: [...BUNDLES], overlays: [], telemetryDisabledEnv: '1',
    })
    await bootCtx.plugin(PluginPackages, { resolution })
    bootCtx.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    } as never)
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

/** Mount the effective `standard` preset on one fresh session. */
async function createStandardAgent(ctx: Context): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(`compaction-live-${Math.random().toString(16).slice(2)}`),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  return { agent: handle.agent, dispose: () => handle.dispose() }
}

/** Read the preset's compaction engine as the raw service, unwrapping Cordis's per-access trace proxy. */
function engineOf(ctx: Context, agent: Agent): BasicCompactionEngine {
  const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
  if (engine === undefined) throw new Error('the standard preset must mount the shipped compaction engine')
  const raw: unknown = Reflect.get(engine, symbols.original)
  return (raw ?? engine) as BasicCompactionEngine
}

/** Validate the Settings descriptor's JSON form and return its exposed field names. */
function schemaFieldNames(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) throw new Error('Settings descriptor schema must be an object')
  const uid = Reflect.get(schema, 'uid')
  const refs = Reflect.get(schema, 'refs')
  if ((typeof uid !== 'string' && typeof uid !== 'number') || typeof refs !== 'object' || refs === null) {
    throw new Error('Settings descriptor schema must carry a uid and refs')
  }
  const form = Reflect.get(refs, uid)
  if (typeof form !== 'object' || form === null) throw new Error(`Settings descriptor has no form for ${uid}`)
  const dict = Reflect.get(form, 'dict')
  if (typeof dict !== 'object' || dict === null) throw new Error(`Settings form ${uid} has no dict`)
  return Object.keys(dict)
}

const homes: string[] = []
afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
})

describe('the shipped Desktop composition compaction seam', () => {
  it('mounts the preset-scoped engine with the Cadre budget and a host-plane settings bridge', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cadre-compaction-settings-'))
    homes.push(home)
    const anchor = await createAnchor(home)
    const ctx = await bootDesktop(home, { anchor, userLayer: false })
    try {
      const { agent } = await createStandardAgent(ctx)
      const engine = engineOf(ctx, agent)
      expect(engine.config).toMatchObject({
        thresholdRatio: 0.9,
        auto: true,
        thresholdTokensCap: 727_040,
        retainTokens: 10_000,
        stepPressureCheck: true,
        stepPressureThresholdTokens: 727_040,
        stepMinToolCallsBetweenChecks: 0,
      })
      // The host-plane `compaction-basic` row stays disabled: the preset row is the engine that runs.
      expect(ctx.get('compaction')).toBeUndefined()
      // The bridge is a real Loader entry in the active include tree and volatile-only.
      const descriptor = ctx.settings.describe().find(row => row.ns === 'compaction-settings')
      expect(descriptor).toBeDefined()
      expect(descriptor?.applies).toBe('live')
      expect(descriptor?.value).toEqual({})
      expect(schemaFieldNames(descriptor?.schema)).toEqual(['auto', 'thresholdRatio'])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('applies live writes without remounting the engine and persists them in the profile patch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cadre-compaction-settings-'))
    homes.push(home)
    const anchor = await createAnchor(home)
    const ctx = await bootDesktop(home, { anchor, userLayer: false })
    try {
      const { agent, dispose } = await createStandardAgent(ctx)
      try {
        const engine = engineOf(ctx, agent)
        await ctx.settings.update('compaction-settings', { thresholdRatio: 0.95 })
        // The same service instance and the composition policy survive the write.
        expect(engineOf(ctx, agent)).toBe(engine)
        expect(engine.config.thresholdRatio).toBe(0.9)
        const described = ctx.settings.describe().find(row => row.ns === 'compaction-settings')
        expect(described?.value).toEqual({ thresholdRatio: 0.95 })
        expect(described?.revision).toBeGreaterThan(0)

        await ctx.settings.update('compaction-settings', { auto: false })
        expect(ctx.settings.describe().find(row => row.ns === 'compaction-settings')?.value)
          .toEqual({ auto: false, thresholdRatio: 0.95 })
        const patch = await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8')
        expect(patch).toContain('id: compaction-settings')
        expect(patch).toContain('thresholdRatio: 0.95')
        expect(patch).toContain('auto: false')
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)

  it('keeps manual compaction available while live auto is false, and applies persisted values on restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cadre-compaction-settings-'))
    homes.push(home)
    const anchor = await createAnchor(home)
    let first: Context | undefined
    let second: Context | undefined
    try {
      first = await bootDesktop(home, { anchor, userLayer: false })
      const { agent, dispose } = await createStandardAgent(first)
      try {
        await first.settings.update('compaction-settings', { auto: false, thresholdRatio: 0.95 })
        expect(await first.commands.execute(agent, '/compact', [], new AbortController().signal))
          .toMatchObject({ result: { kind: 'success' } })
      } finally {
        await dispose()
      }
      await first.fiber.dispose()
      first = undefined

      second = await bootDesktop(home, { anchor, userLayer: true })
      const secondAgent = await createStandardAgent(second)
      try {
        const descriptor = second.settings.describe().find(row => row.ns === 'compaction-settings')
        expect(descriptor?.value).toEqual({ auto: false, thresholdRatio: 0.95 })
        const engine = engineOf(second, secondAgent.agent)
        expect(engine.config).toMatchObject({ thresholdRatio: 0.9, auto: true, thresholdTokensCap: 727_040 })
      } finally {
        await secondAgent.dispose()
      }
    } finally {
      await second?.fiber.dispose()
      await first?.fiber.dispose()
    }
  }, 90_000)

  it('rejects an out-of-range ratio and non-volatile safety fields through the settings executor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cadre-compaction-settings-'))
    homes.push(home)
    const anchor = await createAnchor(home)
    const ctx = await bootDesktop(home, { anchor, userLayer: false })
    try {
      await expect(ctx.settings.update('compaction-settings', { thresholdRatio: 1.5 })).rejects.toThrow()
      await expect(ctx.settings.update('compaction-settings', { thresholdRatio: 0 })).rejects.toThrow()
      await expect(ctx.settings.update('compaction-settings', { thresholdTokens: 100_000 })).rejects.toThrow()
      await expect(ctx.settings.update('compaction-settings', { retainTokens: 20_000 })).rejects.toThrow()
      await expect(ctx.settings.update('compaction-settings', { stepPressureCheck: false })).rejects.toThrow()
      expect(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8')).not.toContain('compaction-settings')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)
})
