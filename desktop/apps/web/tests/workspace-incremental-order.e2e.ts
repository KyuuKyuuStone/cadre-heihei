/** Incremental Session creation/activity through the real Loader and assembled Web page. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EVIDENCE = process.env.DSH_WORKSPACE_INCREMENTAL_EVIDENCE
const EXPECTED_DIR = fileURLToPath(new URL('./expected/workspace-incremental-order', import.meta.url))
const SIDEBAR_EXPECTED = join(EXPECTED_DIR, 'sidebar.expected.md')
const MODE = webSnapshotMode()

it('web e2e: creates and advances Session rows without a list refresh', async () => {
  const scaffold = await launchWebScaffold({})
  let browser: Browser | undefined
  let page: Page | undefined
  let listCalls: ReturnType<typeof vi.spyOn> | undefined
  const timings: {
    sessionId: string; updatedAt: number; publishedAt: number
    stage?: string; domObservedAt?: number
  }[] = []
  const domStages: Record<string, readonly string[]> = {}
  const offActivity = scaffold.ctx.on('api-session/activity', (sessionId, updatedAt) => {
    timings.push({ sessionId, updatedAt, publishedAt: performance.now() })
  })
  try {
    browser = await chromium.launch()
    page = await browser.newPage({
      locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 960 },
    })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-workspace-incremental-order'))
    const setTheme = async (preference: 'dark' | 'light'): Promise<void> => {
      await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: preference }])
      await expect.poll(
        () => page!.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')),
        { timeout: 5_000 },
      ).toBe(preference === 'dark')
      await page!.waitForTimeout(150)
    }
    const initialList = page.waitForResponse('**/api/session/list')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await initialList
    await setTheme('dark')
    listCalls = vi.spyOn(scaffold.ctx.sessionController, 'list')

    const rows = page.locator('[role="treeitem"][data-session-id]')
    const order = async (): Promise<string[]> => rows.evaluateAll(items =>
      items.map(item => item.getAttribute('data-session-id')!))
    const expectOrder = async (expected: readonly string[]): Promise<void> => {
      await expect.poll(order, { timeout: 15_000 }).toEqual([...expected])
      const actual = await order()
      expect(new Set(actual).size).toBe(actual.length)
    }
    const expectNoListRead = (stage: string): void => {
      expect(listCalls!.mock.calls.length, `${stage}: unexpected whole-list read`).toBe(0)
    }
    const markObserved = (stage: string): void => {
      const event = timings.at(-1)
      if (event === undefined) throw new Error(`missing activity for ${stage}`)
      event.stage = stage
      event.domObservedAt = performance.now()
    }
    const appendTurn = async (id: string, updatedAt: number, marker: string): Promise<void> => {
      const session = scaffold.ctx.sessions.get(SessionId(id))
      if (session === undefined) throw new Error(`missing attached Session ${id}`)
      const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
      const clock = vi.spyOn(Date, 'now').mockReturnValue(updatedAt)
      try {
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: marker }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      } finally {
        clock.mockRestore()
      }
      await scaffold.ctx.sessions.flush(session)
    }
    const createInExistingProject = async (): Promise<void> => {
      const project = page!.locator('[role="treeitem"][aria-expanded]')
        .filter({ has: page!.getByText('incremental', { exact: true }) }).first()
      await project.hover()
      await page!.getByRole('button', { name: `在“incremental”中新建`, exact: true }).click()
      await page!.getByRole('menuitem', { name: '普通会话', exact: true }).click()
    }
    const expectNodesConnected = async (handles: Awaited<ReturnType<typeof rows.elementHandles>>): Promise<void> => {
      for (const handle of handles) expect(await handle.evaluate(element => element.isConnected)).toBe(true)
    }

    // Empty and existing lists both insert the created row directly at position zero.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'incremental')
    await page.getByRole('button', { name: '视图选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '按项目组', exact: true }).click()
    await expect.poll(() => rows.count()).toBe(1)
    const a = (await order())[0]!
    await expectOrder([a])
    domStages.emptyCreate = await order()
    expectNoListRead('empty create')
    const t0 = Date.now() + 60_000
    await appendTurn(a, t0, 'engage A')
    await createInExistingProject()
    await expect.poll(() => rows.count()).toBe(2)
    const b = (await order())[0]!
    expect(b).not.toBe(a)
    await expectOrder([b, a])
    domStages.secondCreate = await order()
    expectNoListRead('second create')
    await appendTurn(b, t0 + 1_000, 'engage B')
    await createInExistingProject()
    await expect.poll(() => rows.count()).toBe(3)
    const c = (await order())[0]!
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
    await expectOrder([c, b, a])
    domStages.thirdCreate = await order()
    expectNoListRead('third create')
    await appendTurn(c, t0 + 2_000, 'engage C')
    await expectOrder([c, b, a])
    await page.getByRole('button', { name: '视图选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '最近更新', exact: true }).click()
    await expectOrder([c, b, a])

    domStages.created = await order()
    const handles = await rows.elementHandles()
    await appendTurn(a, t0 + 3_000, 'advance A')
    await expectOrder([a, c, b])
    domStages.activityReorder = await order()
    markObserved('activity reorder')
    await expectNodesConnected(handles)
    expectNoListRead('activity reorder')

    // B crosses strictly older C, but stops behind equal-time A; repeating the
    // same activity timestamp then preserves every relative position and node.
    await appendTurn(b, t0 + 3_000, 'tie B with A')
    await expectOrder([a, b, c])
    domStages.equalTie = await order()
    markObserved('equal-time tie')
    await appendTurn(b, t0 + 3_000, 'repeat equal-time B')
    await expectOrder([a, b, c])
    domStages.equalRepeat = await order()
    markObserved('equal-time repeat')
    await expectNodesConnected(handles)
    expectNoListRead('equal-time activity')

    await page.getByRole('button', { name: '视图选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '手动排序', exact: true }).click()
    await expectOrder([a, b, c])
    await appendTurn(c, t0 + 6_000, 'advance C in manual mode')
    await expectOrder([a, b, c])
    domStages.manualActivity = await order()
    markObserved('manual activity')
    await expectNodesConnected(handles)
    expectNoListRead('manual activity')
    await page.getByRole('button', { name: '视图选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '最近更新', exact: true }).click()
    await expectOrder([c, a, b])
    await expectNodesConnected(handles)
    expectNoListRead('recency restore')

    const projectRow = page.locator('[role="treeitem"][aria-expanded]')
      .filter({ has: page.getByText('incremental', { exact: true }) }).first()
    const projectName = projectRow.getByText('incremental', { exact: true })
    const projectPath = projectRow.locator('span[title]').nth(1)
    const errorRetry = projectRow.getByRole('button', { name: /^花名册读取失败，重试/ })
    const plus = projectRow.getByRole('button', { name: '在“incremental”中新建', exact: true })
    const ledger = projectRow.getByRole('button', { name: '查看“incremental”台账', exact: true })
    const captureProjectLayout = async () => {
      expect(await projectRow.isVisible()).toBe(true)
      expect(await projectName.isVisible()).toBe(true)
      expect(await projectPath.isVisible()).toBe(true)
      expect(await errorRetry.isVisible()).toBe(true)
      const nameBox = await projectName.boundingBox()
      const pathBox = await projectPath.boundingBox()
      const errorBox = await errorRetry.boundingBox()
      const plusBox = await plus.boundingBox()
      if (nameBox === null || pathBox === null || errorBox === null || plusBox === null) {
        throw new Error('missing project-row geometry')
      }
      const nameMetrics = await projectName.evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      const pathTitle = await projectPath.getAttribute('title')
      const buttonOrder = await projectRow.locator('button').evaluateAll(items =>
        items.map(item => item.getAttribute('aria-label') ?? item.textContent?.trim() ?? ''))
      const ledgerIndex = buttonOrder.findIndex(label => label.startsWith('查看“incremental”台账'))
      const errorIndex = buttonOrder.findIndex(label => label.startsWith('花名册读取失败，重试'))
      expect(nameBox.width).toBeGreaterThanOrEqual(64)
      expect(nameMetrics.scrollWidth).toBeLessThanOrEqual(nameMetrics.clientWidth + 1)
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(plusBox.x)
      expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(errorBox.x)
      expect(errorBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height)
      expect(plusBox.y + plusBox.height).toBeLessThanOrEqual(errorBox.y)
      expect(pathTitle).not.toBeNull()
      expect(pathTitle).toContain('incremental')
      expect(ledgerIndex).toBeGreaterThan(-1)
      expect(errorIndex).toBeGreaterThan(ledgerIndex)
      return {
        name: { width: nameBox.width, clientWidth: nameMetrics.clientWidth, scrollWidth: nameMetrics.scrollWidth },
        path: { width: pathBox.width, title: pathTitle },
        errorLine: { top: errorBox.y, nameBottom: nameBox.y + nameBox.height },
        buttons: { plusTop: plusBox.y, ledgerVisible: await ledger.isVisible() },
        buttonOrder,
      }
    }

    const darkLayout = await captureProjectLayout()
    const darkShot = EVIDENCE === undefined ? undefined : join(EVIDENCE, 'workspace-incremental-zh.png')
    const lightShot = EVIDENCE === undefined ? undefined : join(EVIDENCE, 'workspace-incremental-zh-light.png')
    const narrowShot = EVIDENCE === undefined ? undefined : join(EVIDENCE, 'workspace-incremental-zh-narrow.png')
    if (EVIDENCE !== undefined) await mkdir(EVIDENCE, { recursive: true })
    await page.mouse.move(720, 480)
    if (darkShot !== undefined) {
      await page.screenshot({ path: darkShot, fullPage: true, animations: 'disabled' })
    }
    await setTheme('light')
    const lightLayout = await captureProjectLayout()
    if (lightShot !== undefined) {
      await page.screenshot({ path: lightShot, fullPage: true, animations: 'disabled' })
    }
    await setTheme('dark')
    await page.setViewportSize({ width: 1024, height: 768 })
    await expect.poll(() => page!.evaluate(() => document.documentElement.clientWidth)).toBe(1024)
    await page.mouse.move(512, 384)
    const narrowLayout = await captureProjectLayout()
    if (narrowShot !== undefined) {
      await page.screenshot({ path: narrowShot, fullPage: true, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await expect.poll(() => page!.evaluate(() => document.documentElement.clientWidth)).toBe(1440)
    await page.locator('[role="treeitem"][data-session-id]')
      .filter({ has: page.getByText('engage B', { exact: true }) }).first().hover()

    const aria = (await captureStableAria(page, '[role="tree"][aria-label="会话"]', scaffold.workspaceCwd, {
      normalizeAge: true,
    }))
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .replaceAll(scaffold.workspaceCwd.replaceAll('\\', '\\\\'), '{{cwd}}')
    expect(aria).toContain('项目组')
    expect(aria).not.toContain('项目部')
    expect(aria).toContain('查看“incremental”台账 花名册读取失败')
    if (MODE === 'refresh') await mkdir(EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(SIDEBAR_EXPECTED, aria, MODE)
    await assertFixtureInventory(EXPECTED_DIR, ['sidebar.expected.md'])
    await projectRow.hover()
    await expect.poll(
      () => page!.locator('[role="button"][aria-label^="复制:"]').count(),
      { timeout: 5_000 },
    ).toBe(1)
    const hoverCopyLabel = await page.locator('[role="button"][aria-label^="复制:"]').getAttribute('aria-label')
    expect(hoverCopyLabel).toContain(`复制: ${scaffold.workspaceCwd}`)
    expect(await page.getByText('incremental', { exact: true }).count()).toBeGreaterThanOrEqual(2)
    domStages.finalRecency = await order()
    const summary = {
      finalOrder: await order(), domStages, aria, listReadCount: listCalls.mock.calls.length,
      uniqueNodes: new Set(domStages.finalRecency).size === domStages.finalRecency.length,
      nodeIdentityPreserved: true,
      layout: { dark: darkLayout, light: lightLayout, narrow: narrowLayout },
      hoverCard: { fullNameVisible: true, copyLabel: hoverCopyLabel },
      eventTiming: timings.map(event => ({
        ...event,
        domObservationDelayMs: event.domObservedAt === undefined ? undefined : event.domObservedAt - event.publishedAt,
      })),
      screenshot: darkShot,
      screenshots: {
        dark: darkShot,
        light: lightShot,
        narrow: narrowShot,
      },
    }
    if (EVIDENCE !== undefined) {
      await writeFile(join(EVIDENCE, 'workspace-incremental-evidence.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
      await writeFile(join(EVIDENCE, 'workspace-incremental-aria.txt'), `${aria}\n`, 'utf8')
    }
    console.log(`workspace-incremental ${JSON.stringify(summary)}`)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    listCalls?.mockRestore()
    offActivity()
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
