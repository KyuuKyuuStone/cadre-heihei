// 从 cc-heihei v1.7.9（desktop/src/i18n/locale.test.ts）搬迁。
// 适配：vitest + jsdom → node:test + 最小 DOM/storage/navigator stub；
// 用例语义与断言逐条保留，未删用例。
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  initializeLocale,
  LEGACY_LOCALE_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  readStoredLocale,
  resolveSupportedLocale,
  subscribeLocaleChanges,
  type Locale,
  type LocaleRuntime,
} from '../../../src/renderer/i18n/locale.ts'

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value))
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => storage.clear(),
}
const documentStub = { documentElement: { lang: 'en' } }

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageStub })
Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })

function setNavigator(languages: string[] | (() => string[]), language = '') {
  const value = {}
  Object.defineProperty(value, 'languages', {
    configurable: true,
    enumerable: true,
    get: () => (typeof languages === 'function' ? languages() : languages),
  })
  Object.defineProperty(value, 'language', {
    configurable: true,
    enumerable: true,
    get: () => language,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
}

function makeHost(overrides: Partial<LocaleRuntime> = {}): LocaleRuntime {
  return {
    getLocalePreference: async () => null,
    getPreferredSystemLanguages: async () => [],
    setLocalePreference: async () => {},
    onLocaleChanged: async () => () => {},
    ...overrides,
  }
}

describe('locale detection', { concurrency: 1 }, () => {
  beforeEach(() => {
    storage.clear()
    documentStub.documentElement.lang = 'en'
    setNavigator(['en-US'])
  })

  it('normalizes BCP 47 tags and selects the first supported language', () => {
    assert.equal(resolveSupportedLocale(['fr-FR', 'zh_Hant_HK', 'en-US']), 'zh-TW')
    assert.equal(resolveSupportedLocale(['zh-Hans-HK']), 'zh')
  })

  it('uses Electron preferred system languages before the renderer fallback', async () => {
    setNavigator(['en-US'])
    const host = makeHost({
      getPreferredSystemLanguages: async () => ['fr-FR', 'ko-KR'],
    })

    assert.equal(await initializeLocale(host), 'kr')
    assert.equal(documentStub.documentElement.lang, 'ko')
  })

  it('falls back to renderer languages when the native lookup fails', async () => {
    setNavigator(['ja-JP'])
    const host = makeHost({
      getLocalePreference: () => Promise.reject(new Error('IPC unavailable')),
      getPreferredSystemLanguages: () => Promise.reject(new Error('IPC unavailable')),
    })

    assert.equal(await initializeLocale(host), 'jp')
    assert.equal(documentStub.documentElement.lang, 'ja')
  })

  it('migrates a stored main-window choice without consulting the system again', async () => {
    storage.set(LEGACY_LOCALE_STORAGE_KEY, 'zh-TW')
    let preferenceCalls = 0
    let systemCalls = 0
    const setCalls: Locale[] = []
    const host = makeHost({
      getLocalePreference: async () => {
        preferenceCalls += 1
        return null
      },
      getPreferredSystemLanguages: async () => {
        systemCalls += 1
        return ['en-US']
      },
      setLocalePreference: async (locale) => {
        setCalls.push(locale)
      },
    })

    assert.equal(await initializeLocale(host), 'zh-TW')
    assert.deepEqual(setCalls, ['zh-TW'])
    assert.equal(preferenceCalls, 0)
    assert.equal(systemCalls, 0)
    assert.equal(documentStub.documentElement.lang, 'zh-TW')
  })

  it('uses the app-level manual preference in an isolated companion partition', async () => {
    setNavigator(['zh-CN'])
    const host = makeHost({
      getLocalePreference: async () => 'jp',
    })

    assert.equal(await initializeLocale(host), 'jp')
    assert.equal(documentStub.documentElement.lang, 'ja')
  })

  it('applies app-level locale changes to an already running companion window', async () => {
    let onLocaleChanged: ((locale: Locale) => void) | undefined
    const seen: string[] = []
    const unsubscribe = subscribeLocaleChanges((locale) => seen.push(locale))

    const host = makeHost({
      getLocalePreference: async () => 'en',
      onLocaleChanged: async (handler) => {
        onLocaleChanged = handler
        return () => {}
      },
    })

    await initializeLocale(host)
    onLocaleChanged?.('kr')
    unsubscribe()

    assert.ok(seen.includes('kr'), `listener 未收到 kr：${JSON.stringify(seen)}`)
    assert.equal(documentStub.documentElement.lang, 'ko')
  })

  it('migrates the legacy key once and writes the new key', () => {
    storage.set(LEGACY_LOCALE_STORAGE_KEY, 'zh-TW')

    assert.equal(readStoredLocale(), 'zh-TW')
    assert.equal(storage.get(LOCALE_STORAGE_KEY), 'zh-TW')
    // 旧键保留给前身应用，不做删除。
    assert.equal(storage.get(LEGACY_LOCALE_STORAGE_KEY), 'zh-TW')
  })

  it('prefers the new key over the legacy key', () => {
    storage.set(LOCALE_STORAGE_KEY, 'jp')
    storage.set(LEGACY_LOCALE_STORAGE_KEY, 'zh')

    assert.equal(readStoredLocale(), 'jp')
  })

  it('ignores an invalid legacy value and does not write the new key', () => {
    storage.set(LEGACY_LOCALE_STORAGE_KEY, 'fr-FR')

    assert.equal(readStoredLocale(), null)
    assert.equal(storage.has(LOCALE_STORAGE_KEY), false)
  })

  it('uses navigator.language when navigator.languages is unavailable', async () => {
    setNavigator(() => {
      throw new Error('languages unavailable')
    }, 'ja-JP')
    const host = makeHost({
      getPreferredSystemLanguages: () => Promise.reject(new Error('IPC unavailable')),
    })

    assert.equal(await initializeLocale(host), 'jp')
  })
})
