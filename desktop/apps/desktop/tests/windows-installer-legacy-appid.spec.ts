/** The 0.8.8 application id rename keeps upgrade recognition and registry retirement aligned. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const LEGACY_GUID = '7808434f-469e-5eba-848e-edf64d3b94ce'
const LEGACY_READ = 'ReadRegStr $0 HKCU "${DSH_LEGACY_INSTALL_REGISTRY_KEY}" "InstallLocation"'

it('recognizes and retires the pre-0.8.8 application id keys without touching other products', () => {
  const installerSource = readFileSync(join(import.meta.dirname, '..', 'scripts', 'installer.nsh'), 'utf8')
  expect(installerSource).toContain(`"Software\\${LEGACY_GUID}"`)
  expect(installerSource).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACY_GUID}"`)
  const customInstall = installerSource.slice(installerSource.indexOf('\n!macro customInstall\n'))
  expect(customInstall).toContain(LEGACY_READ)
  expect(customInstall.indexOf(LEGACY_READ)).toBeLessThan(customInstall.indexOf('DeleteRegKey HKCU "${DSH_LEGACY_INSTALL_REGISTRY_KEY}"'))
  expect(customInstall).toContain('DeleteRegKey HKCU "${DSH_LEGACY_UNINSTALL_REGISTRY_KEY}"')
  const pathSource = readFileSync(join(import.meta.dirname, '..', 'installer', 'path.nsh'), 'utf8')
  expect(pathSource).toContain(LEGACY_READ)
})

it('defaults every unsigned build preset to the renamed application id', () => {
  const environmentSource = readFileSync(join(import.meta.dirname, '..', 'scripts', 'desktop-package-environment.mjs'), 'utf8')
  expect(environmentSource).toContain("DSH_DESKTOP_APP_ID: 'com.cadre.heihei'")
  expect(environmentSource).not.toContain("'com.deepseek.harness'")
})
