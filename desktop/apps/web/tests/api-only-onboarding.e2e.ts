// Keyless real-composition evidence: the shipped Loader enters the credential
// editor directly, while the signed-out launcher offers only that same editor.
// Screenshots and sanitized browser logs are artifacts, never committed goldens.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const TEST_KEY = 'dsh_api_only_onboarding_test'
const EVIDENCE = process.env.DSH_API_ONLY_EVIDENCE
  ?? fileURLToPath(new URL('../../../.artifacts/api-only-onboarding', import.meta.url))
const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/api-only-onboarding/cordis.patch.yml', import.meta.url))
const ACCOUNT_HOST_PACKAGE = fileURLToPath(new URL('../../../packages/credentials/deepseek-account-platform', import.meta.url))
const ACCOUNT_CONTROLLER_PACKAGE = fileURLToPath(new URL('../../../packages/api/account-controller', import.meta.url))
const ACCOUNT_CLIENT_PACKAGE = fileURLToPath(new URL('../../../packages/client/ui-settings-account', import.meta.url))
const CASES = [
  {
    name: 'zh-light-wide', locale: ZH_BROWSER_LOCALE, colorScheme: 'light' as const,
    viewport: { width: 1440, height: 960 }, title: '添加一个 API Key 开始使用', legacyTitle: '开始使用',
    keyLabel: 'API 密钥', later: '稍后配置', save: '保存并继续', menu: '账号菜单', add: '添加 API Key', signIn: '登录',
  },
  {
    name: 'zh-dark-wide', locale: ZH_BROWSER_LOCALE, colorScheme: 'dark' as const,
    viewport: { width: 1440, height: 960 }, title: '添加一个 API Key 开始使用', legacyTitle: '开始使用',
    keyLabel: 'API 密钥', later: '稍后配置', save: '保存并继续', menu: '账号菜单', add: '添加 API Key', signIn: '登录',
  },
  {
    name: 'en-light-narrow', locale: 'en-US', colorScheme: 'light' as const,
    viewport: { width: 390, height: 844 }, title: 'Add an API key to get started', legacyTitle: 'Get started',
    keyLabel: 'API key', later: 'Configure later', save: 'Save and continue', menu: 'Account menu', add: 'Add API Key', signIn: 'Sign in',
  },
]

/** Keep request methods and paths while removing credentials from URL queries and fragments. */
function safeRequestUrl(raw: string): string {
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return '[non-network URL]'
  const url = new URL(raw)
  return `${url.origin}${url.pathname}`
}

/** Remove the known dummy credential and common authorization query values from console evidence. */
function sanitizeText(text: string): string {
  return text.replaceAll(TEST_KEY, '[redacted-test-key]')
    .replace(/([?&](?:token|api[-_]?key|key|code)=)[^&\s]+/gi, '$1[redacted]')
}

describe.skipIf(MODE === 'record')('web e2e: API-Key-only account onboarding', () => {
  it('routes keyless startup and the signed-out menu without account authorization', async () => {
    await mkdir(EVIDENCE, { recursive: true })
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let platform: Server | undefined
    let root: string | undefined
    const platformRequests: string[] = []
    try {
      platform = createServer((request, response) => {
        platformRequests.push(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
        response.writeHead(404).end()
      })
      await new Promise<void>((resolve) => { platform!.listen(0, '127.0.0.1', resolve) })
      const address = platform.address()
      if (address === null || typeof address === 'string') throw new Error('API-only evidence: missing Platform listener')
      root = await mkdtemp(join(tmpdir(), 'dsh-web-api-only-'))
      const overlay = join(root, 'api-only.overlay.yml')
      await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8'))
        .replaceAll('{{origin}}', `http://127.0.0.1:${String(address.port)}`))
      scaffold = await launchWebScaffold({
        deepSeekMissingCredential: true,
        extraOverlayPath: overlay,
        profile: {
          packages: [
            { dir: ACCOUNT_HOST_PACKAGE }, { dir: ACCOUNT_CONTROLLER_PACKAGE }, { dir: ACCOUNT_CLIENT_PACKAGE },
          ],
        },
      })
      browser = await chromium.launch()
      for (const testCase of CASES) {
        await scaffold.ctx.settings.update('ui-theme', { preference: testCase.colorScheme })
        const page = await browser.newPage({
          viewport: testCase.viewport, locale: testCase.locale, colorScheme: testCase.colorScheme,
        })
        const consoleLines: string[] = []
        const pageErrors: string[] = []
        const networkLines: string[] = []
        const tripwire = watchConsole(page)
        page.on('console', message => { consoleLines.push(`${message.type()} ${sanitizeText(message.text())}`) })
        page.on('pageerror', error => { pageErrors.push(sanitizeText(error.stack ?? error.message)) })
        page.on('request', request => { networkLines.push(`${request.method()} ${safeRequestUrl(request.url())}`) })
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          const dialog = page.getByRole('dialog', { name: testCase.title, exact: true })
          await dialog.waitFor({ timeout: 20_000 })
          const input = dialog.getByRole('textbox', { name: testCase.keyLabel, exact: true })
          expect(await input.isVisible()).toBe(true)
          expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
          expect(await page.getByRole('dialog', { name: testCase.legacyTitle, exact: true }).count()).toBe(0)
          expect(await page.getByRole('button', { name: testCase.signIn, exact: true }).count()).toBe(0)
          expect(await page.evaluate(
            colorScheme => matchMedia(`(prefers-color-scheme: ${colorScheme})`).matches,
            testCase.colorScheme,
          )).toBe(true)
          await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
            .toBe(testCase.colorScheme === 'dark')

          if (testCase.name === 'zh-light-wide') {
            await dialog.getByRole('button', { name: testCase.later, exact: true }).click()
            await dialog.waitFor({ state: 'detached' })
            expect(await page.getByRole('dialog', { name: testCase.legacyTitle, exact: true }).count()).toBe(0)
            const launcher = page.getByRole('button', { name: testCase.menu, exact: true })
            await launcher.click()
            expect(await page.getByRole('menuitem', { name: testCase.signIn, exact: true }).count()).toBe(0)
            const add = page.getByRole('menuitem', { name: testCase.add, exact: true })
            await add.waitFor()
            await page.screenshot({ path: join(EVIDENCE, 'account-menu-zh-light.png'), fullPage: true, animations: 'disabled' })
            await add.click()
            await dialog.waitFor()
            const reopenedInput = dialog.getByRole('textbox', { name: testCase.keyLabel, exact: true })
            expect(await reopenedInput.evaluate(element => element === document.activeElement)).toBe(true)
            await dialog.getByRole('button', { name: testCase.later, exact: true }).click()
            await dialog.waitFor({ state: 'detached', timeout: 15_000 })
            await launcher.click()
            await add.click()
            await dialog.waitFor()
            expect(await page.getByRole('dialog', { name: testCase.legacyTitle, exact: true }).count()).toBe(0)
          } else if (testCase.name === 'en-light-narrow') {
            await input.fill('   ')
            const error = dialog.getByText('Enter an API key to continue.', { exact: true })
            await error.waitFor()
            expect(await error.isVisible()).toBe(true)
            expect(await input.getAttribute('aria-invalid')).toBe('true')
            expect(await dialog.getByRole('button', { name: testCase.save, exact: true }).isDisabled()).toBe(true)
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          }

          await page.screenshot({
            path: join(EVIDENCE, `onboarding-${testCase.name}.png`), fullPage: true, animations: 'disabled',
          })
          if (testCase.name === 'en-light-narrow') {
            await input.fill(TEST_KEY)
            await dialog.getByRole('button', { name: testCase.save, exact: true }).click()
            await expect.poll(async () => networkLines.some(line => line.endsWith('/api/credentials/set'))).toBe(true)
            await expect.poll(async () => {
              const credentials = await readFile(join(scaffold!.harnessHome, '.credentials.yaml'), 'utf8')
              return credentials.includes(TEST_KEY)
            }).toBe(true)
            await dialog.waitFor({ state: 'detached', timeout: 15_000 })
          }
          expect(networkLines.some(line => /\/auth-api\/v0\/dsh\/|\/dsh\/authorize/.test(line))).toBe(false)
          expect(consoleLines.some(line => line.includes(TEST_KEY))).toBe(false)
          expect(pageErrors).toEqual([])
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
        } catch (error) {
          await saveFailureShot(page, `web-e2e-api-only-${testCase.name}`)
          throw error
        } finally {
          await Promise.all([
            writeFile(join(EVIDENCE, `console-${testCase.name}.log`), `${consoleLines.join('\n')}\n`, 'utf8'),
            writeFile(join(EVIDENCE, `pageerror-${testCase.name}.log`), `${pageErrors.join('\n')}\n`, 'utf8'),
            writeFile(join(EVIDENCE, `network-${testCase.name}.log`), `${networkLines.join('\n')}\n`, 'utf8'),
          ])
          await page.close()
        }
      }
      expect(platformRequests).toEqual([])
    } finally {
      await browser?.close()
      await scaffold?.close()
      await writeFile(join(EVIDENCE, 'host-platform-network.log'), `${platformRequests.join('\n')}\n`, 'utf8')
      if (platform !== undefined) {
        await new Promise<void>((resolve) => { platform!.close(() => { resolve() }); platform!.closeAllConnections() })
      }
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
