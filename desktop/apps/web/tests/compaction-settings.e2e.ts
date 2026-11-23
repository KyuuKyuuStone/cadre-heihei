// Assembled-browser evidence for live context-compaction settings. The real
// Loader boots the shipped Web and Cadre bundles; edits cross the HTTP Host
// bridge and the same Agent, Session, engine, and Loader fiber must survive.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page, type Response } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import yaml from 'js-yaml'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const CADRE_APP = fileURLToPath(new URL('../../../packages/bundle/cadre-app', import.meta.url))
const PIN_PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./compaction-settings.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/compaction-settings', import.meta.url))
const PAGE_EXPECTED = join(SNAPSHOT_DIR, 'page.expected.md')
const EVIDENCE_DIR = process.env.DSH_COMPACTION_EVIDENCE_DIR
  ?? fileURLToPath(new URL('../../../.artifacts/compaction-settings', import.meta.url))
const MODE = webSnapshotMode()
const evidence = new Map<string, string | number | boolean | string[]>()
const screenshots: string[] = []

interface MutationRequest {
  payload: { args: { ns: string; revision?: number; ops: { op: string; path: string[]; value?: boolean | number }[] } }
}

interface MutationEnvelope {
  result: {
    ok: boolean
    value?: { ns: string; value: { auto?: boolean; thresholdRatio?: number } }
    error?: { code: string; details?: { ns?: string } }
  }
}

interface PatchRow {
  id?: string
  config?: { auto?: boolean; thresholdRatio?: number }
}

/** Save a full-page rendered-state image into this run's evidence directory. */
async function shot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  const path = join(EVIDENCE_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  screenshots.push(`${name}.png`)
}

/** A locked form's resets must read as disabled, refuse focus, and stay de-emphasized. */
async function expectDisabledResets(form: Locator): Promise<void> {
  const resets = form.getByRole('button', { name: '恢复默认', exact: true })
  expect(await resets.count()).toBe(2)
  for (const reset of await resets.all()) {
    expect(await reset.isDisabled()).toBe(true)
    expect(await reset.evaluate(element => {
      if (!(element instanceof HTMLButtonElement)) return true
      element.focus()
      return document.activeElement === element
    })).toBe(false)
  }
  for (const opacity of await resets.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))) {
    expect(Number(opacity)).toBeLessThanOrEqual(0.5)
    evidence.set('disabledResetOpacity', Number(opacity))
  }
}

/** Open the real Plugins page, returning its current panel locator. */
async function openPlugins(page: Page): Promise<Locator> {
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.waitFor({ timeout: 10_000 })
  while (await panel.getByRole('button', { name: /^返回/ }).count() > 0) {
    await panel.getByRole('button', { name: /^返回/ }).first().click()
  }
  await panel.getByRole('heading', { name: '内置插件配置', exact: true }).waitFor({ timeout: 20_000 })
  return panel
}

/** Open the compaction form registered by the shipped client package. */
async function openCompaction(page: Page): Promise<Locator> {
  const panel = await openPlugins(page)
  await panel.getByRole('button', { name: '查看 上下文压缩', exact: true }).click()
  const form = panel.locator('[data-plugin-item-detail="compaction-settings"]').locator('[data-plugin-config]')
  await form.waitFor({ timeout: 10_000 })
  return form
}

/** Match only this namespace's real HTTP Settings mutation. */
function compactionMutation(response: Response): boolean {
  if (new URL(response.url()).pathname !== '/api/settings/mutate' || response.request().method() !== 'POST') return false
  const request = response.request().postDataJSON() as MutationRequest
  return request.payload.args.ns === 'compaction-settings'
}

/** Strip Cordis's per-access trace proxy before comparing service identity. */
function originalOf<T extends object>(value: T): T {
  const original = Reflect.get(value, symbols.original) as T | undefined
  return original ?? value
}

/** Read the effective preset engine without retaining Cordis's trace proxy. */
function engineOf(ctx: Context, agent: Agent): BasicCompactionEngine {
  const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
  if (engine === undefined) throw new Error('the standard preset must mount the shipped compaction engine')
  return originalOf(engine) as BasicCompactionEngine
}

/** Read the durable compaction row from the editable profile layer. */
async function profileValue(scaffold: WebScaffold): Promise<PatchRow['config']> {
  const path = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
  const rows = yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema }) as PatchRow[]
  return rows.find(row => row.id === 'compaction-settings')?.config
}

it('omits the compaction page when the shipped namespace is absent', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: PIN_PICKER })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const panel = await openPlugins(page)
    await panel.getByRole('button', { name: '查看 Agent 循环', exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: '查看 上下文压缩', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.settings.describe().some(row => row.ns === 'compaction-settings')).toBe(false)
    await shot(page, 'namespace-absent')
    expect(tripwire.pageErrors).toEqual([])
    evidence.set('namespaceAbsent', true)
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)

describe('web e2e: live context compaction settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profile: { hmr: true, packages: [{ dir: CADRE_APP, enabled: true }] },
      extraOverlayPath: [PIN_PICKER, OVERLAY],
    })
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'light' }])
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'compaction-settings')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    evidence.set('screenshots', screenshots)
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(join(EVIDENCE_DIR, 'browser-evidence.json'), `${JSON.stringify(Object.fromEntries(evidence), null, 2)}\n`)
  })

  it('reads, edits, saves, and applies through the real bridge without remounting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compaction-settings-save'))
    await expect.poll(() => scaffold.ctx.agents.list().length).toBeGreaterThan(0)
    const agent = scaffold.ctx.agents.list()[0]!
    const session = agent.session
    const engine = engineOf(scaffold.ctx, agent)
    const settingsService = scaffold.ctx.compactionSettings
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'compaction-settings')!
    const fiber = entry.fiber
    expect(engine.config).toMatchObject({ auto: true, thresholdRatio: 0.9 })
    expect(settingsService.current()).toEqual({})
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'compaction-settings')?.value).toEqual({})

    const form = await openCompaction(page)
    const inherited = form.getByRole('tab', { name: '跟随部署', exact: true })
    expect(await inherited.getAttribute('aria-selected')).toBe('true')
    expect(await form.locator('#plugin-config-compaction-threshold-ratio').inputValue()).toBe('')
    expect(await form.getByText('thresholdTokens', { exact: true }).count()).toBe(1)
    expect(await form.getByRole('textbox', { name: /thresholdTokens/ }).count()).toBe(0)
    await shot(page, 'light-inherited')

    await inherited.focus()
    await inherited.press('ArrowRight')
    expect(await form.getByRole('tab', { name: '开启', exact: true }).getAttribute('aria-selected')).toBe('true')
    await form.getByRole('tab', { name: '开启', exact: true }).press('ArrowRight')
    const disabled = form.getByRole('tab', { name: '关闭', exact: true })
    expect(await disabled.getAttribute('aria-selected')).toBe('true')
    expect(await disabled.evaluate(element => document.activeElement === element)).toBe(true)
    await shot(page, 'keyboard-focus')
    const ratio = form.locator('#plugin-config-compaction-threshold-ratio')
    await ratio.fill('1.5')
    await form.getByText('请输入大于 0 且不超过 1 的数字；留空表示跟随部署。', { exact: true }).waitFor()
    expect(await form.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    await shot(page, 'invalid-ratio')
    await ratio.fill('0.72')

    let releaseSave = (): void => {}
    const gate = new Promise<void>(resolve => { releaseSave = resolve })
    const originalMutate = scaffold.ctx.settings.mutate.bind(scaffold.ctx.settings)
    const delayed = vi.spyOn(scaffold.ctx.settings, 'mutate').mockImplementationOnce(async (ns, ops, revision) => {
      await gate
      return await originalMutate(ns, ops, revision)
    })
    try {
      const responsePromise = page.waitForResponse(compactionMutation)
      await form.getByRole('button', { name: '保存', exact: true }).click()
      await form.getByRole('button', { name: '保存中…', exact: true }).waitFor()
      expect(await disabled.isDisabled()).toBe(true)
      expect(await ratio.isDisabled()).toBe(true)
      await expectDisabledResets(form)
      const reset = form.getByRole('button', { name: '恢复默认', exact: true }).first()
      await reset.evaluate(element => { if (element instanceof HTMLButtonElement) element.click() })
      expect(await ratio.inputValue()).toBe('0.72')
      evidence.set('savingDisabledResetFocusable', false)
      evidence.set('savingDisabledResetClickMutated', false)
      await shot(page, 'saving')
      releaseSave()
      const response = await responsePromise
      expect(response.status()).toBe(200)
      expect(await response.finished()).toBeNull()
      const envelope = await response.json() as MutationEnvelope
      expect(envelope.result.ok).toBe(true)
      expect(envelope.result.value).toMatchObject({ ns: 'compaction-settings', value: { auto: false, thresholdRatio: 0.72 } })
      evidence.set('saveResponse', JSON.stringify(envelope))
      expect(delayed).toHaveBeenCalledOnce()
    } finally {
      releaseSave()
      delayed.mockRestore()
    }

    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'compaction-settings')?.value)
      .toEqual({ auto: false, thresholdRatio: 0.72 })
    await expect.poll(() => scaffold.ctx.compactionSettings.current()).toEqual({ auto: false, thresholdRatio: 0.72 })
    await expect.poll(() => profileValue(scaffold)).toEqual({ auto: false, thresholdRatio: 0.72 })
    await expect.poll(() => form.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    expect(scaffold.ctx.agents.list()[0]).toBe(agent)
    expect(agent.session).toBe(session)
    expect(engineOf(scaffold.ctx, agent)).toBe(engine)
    expect(originalOf(scaffold.ctx.compactionSettings)).toBe(originalOf(settingsService))
    expect([...scaffold.ctx.loader.entries()].find(row => row.options.id === 'compaction-settings')?.fiber).toBe(fiber)
    expect(engine.config).toMatchObject({ auto: true, thresholdRatio: 0.9 })
    evidence.set('liveValues', JSON.stringify(scaffold.ctx.compactionSettings.current()))
    evidence.set('durableValues', JSON.stringify(await profileValue(scaffold)))
    evidence.set('sameAgentSessionEngineServiceFiber', true)

    const enabledResets = form.getByRole('button', { name: '恢复默认', exact: true })
    expect(await enabledResets.count()).toBe(2)
    for (const reset of await enabledResets.all()) expect(await reset.isDisabled()).toBe(false)
    await shot(page, 'light-saved')

    const snapshot = await captureStableAria(page, '[data-plugin-item-detail="compaction-settings"]', scaffold.workspaceCwd)
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(PAGE_EXPECTED, snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['page.expected.md'])

    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await shot(page, 'dark-saved')
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'light' }])
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)

    await page.setViewportSize({ width: 640, height: 1100 })
    await form.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded()
    const layout = await form.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textLength: element.textContent?.length ?? 0,
    }))
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
    expect(layout.textLength).toBeGreaterThan(500)
    expect(await form.getByRole('tab', { name: '跟随部署', exact: true }).isVisible()).toBe(true)
    expect(await form.getByRole('button', { name: '保存', exact: true }).isVisible()).toBe(true)
    evidence.set('narrowLayout', JSON.stringify(layout))
    await shot(page, 'narrow-long-zh')
    await page.setViewportSize({ width: 1680, height: 1100 })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('keeps the draft and live identities after a real bridge refusal', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compaction-settings-error'))
    const agent = scaffold.ctx.agents.list()[0]!
    const session = agent.session
    const engine = engineOf(scaffold.ctx, agent)
    const before = scaffold.ctx.compactionSettings.current()
    const durableBefore = await profileValue(scaffold)
    const form = await openCompaction(page)
    const ratio = form.locator('#plugin-config-compaction-threshold-ratio')
    await ratio.fill('0.73')
    const refusal = vi.spyOn(scaffold.ctx.settings, 'mutate').mockRejectedValueOnce(new Error('e2e injected refusal'))
    try {
      const responsePromise = page.waitForResponse(compactionMutation)
      await form.getByRole('button', { name: '保存', exact: true }).click()
      const response = await responsePromise
      expect(response.status()).toBe(200)
      const envelope = await response.json() as MutationEnvelope
      expect(envelope.result.ok).toBe(false)
      expect(envelope.result.error).toMatchObject({ code: 'settings/rejected', details: { ns: 'compaction-settings' } })
      evidence.set('errorResponse', JSON.stringify(envelope))
    } finally {
      refusal.mockRestore()
    }
    await form.getByText('本部署没有接受这些值，已保留供你修改。', { exact: true }).waitFor()
    expect(await ratio.inputValue()).toBe('0.73')
    expect(scaffold.ctx.compactionSettings.current()).toEqual(before)
    expect(await profileValue(scaffold)).toEqual(durableBefore)
    expect(scaffold.ctx.agents.list()[0]).toBe(agent)
    expect(agent.session).toBe(session)
    expect(engineOf(scaffold.ctx, agent)).toBe(engine)
    await shot(page, 'save-error')
    evidence.set('failureKeptDraftAndIdentities', true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('shows persisted values and disables writes when the real Host is read-only', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compaction-settings-readonly'))
    const writable = vi.spyOn(scaffold.ctx.settings, 'writable', 'get').mockReturnValue(false)
    let mutations = 0
    const countMutation = (request: { url(): string; method(): string }): void => {
      if (new URL(request.url()).pathname === '/api/settings/mutate' && request.method() === 'POST') mutations += 1
    }
    page.on('request', countMutation)
    try {
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const form = await openCompaction(page)
      await form.getByText('本部署的设置为只读。', { exact: true }).waitFor()
      expect(await form.getByRole('tab', { name: '关闭', exact: true }).getAttribute('aria-selected')).toBe('true')
      expect(await form.locator('#plugin-config-compaction-threshold-ratio').inputValue()).toBe('0.72')
      for (const tab of await form.getByRole('tab').all()) expect(await tab.isDisabled()).toBe(true)
      const ratio = form.locator('#plugin-config-compaction-threshold-ratio')
      expect(await ratio.isDisabled()).toBe(true)
      await expectDisabledResets(form)
      const reset = form.getByRole('button', { name: '恢复默认', exact: true }).first()
      await reset.evaluate(element => { if (element instanceof HTMLButtonElement) element.click() })
      expect(await ratio.inputValue()).toBe('0.72')
      expect(mutations).toBe(0)
      evidence.set('readOnlyDisabledResetFocusable', false)
      evidence.set('readOnlyDisabledResetClickMutated', false)
      const save = form.getByRole('button', { name: '保存', exact: true })
      expect(await save.isDisabled()).toBe(true)
      await save.evaluate(element => { if (element instanceof HTMLButtonElement) element.click() })
      expect(mutations).toBe(0)
      await shot(page, 'read-only')
      await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
      await shot(page, 'read-only-dark')
      evidence.set('readOnlyPersistedWithoutMutation', true)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      page.off('request', countMutation)
      writable.mockRestore()
    }
  }, 60_000)
})
