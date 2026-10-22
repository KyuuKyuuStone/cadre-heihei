export type Locale = 'en' | 'zh' | 'zh-TW' | 'jp' | 'kr'

// 新产品独立键；旧键只做一次性读取迁移（读到即写新键，旧键保留给前身应用）。
export const LOCALE_STORAGE_KEY = 'cadre-heihei-locale'
export const LEGACY_LOCALE_STORAGE_KEY = 'cc-heihei-locale'

export const VALID_LOCALES: readonly Locale[] = ['en', 'zh', 'zh-TW', 'jp', 'kr']
/** 与 shared/ipc.ts 的 DEFAULT_PREFERENCES.locale 保持一致：首次启动默认中文。 */
export const DEFAULT_LOCALE: Locale = 'zh'
const DOCUMENT_LANG: Record<Locale, string> = {
  en: 'en',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  jp: 'ja',
  kr: 'ko',
}

let initializedLocale: Locale | null = null
const localeChangeListeners = new Set<(locale: Locale) => void>()

export type LocaleRuntime = {
  getLocalePreference(): Promise<Locale | null>
  getPreferredSystemLanguages(): Promise<string[]>
  setLocalePreference(locale: Locale): Promise<void>
  onLocaleChanged(handler: (locale: Locale) => void): Promise<() => void>
}

// 搬迁适配：新 app 的 tsc 暂未启用 DOM lib（renderer 尚未接入 UI 框架）。
// 这里用最小结构类型访问浏览器全局，避免为 Node 侧配置整体打开 DOM lib。
type BrowserGlobals = {
  document?: { documentElement: { lang: string } }
  localStorage?: {
    getItem(key: string): string | null
    setItem?(key: string, value: string): void
  }
  navigator?: { languages?: readonly string[]; language?: string }
}

const browser = globalThis as unknown as BrowserGlobals

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string'
    && (VALID_LOCALES as readonly string[]).includes(value)
}

export function readBrowserLanguages(): string[] {
  const nav = browser.navigator
  if (!nav) return []

  try {
    const languages = nav.languages
    if (Array.isArray(languages) && languages.length > 0) return [...languages]
  } catch {
    // Continue to the singular language fallback.
  }

  try {
    return nav.language ? [nav.language] : []
  } catch {
    return []
  }
}

function mapLanguageTag(languageTag: string): Locale | null {
  const [language, ...subtags] = languageTag.trim().replace(/_/g, '-').toLowerCase().split('-')
  if (language === 'en') return 'en'
  if (language === 'ja') return 'jp'
  if (language === 'ko') return 'kr'
  if (language !== 'zh') return null

  if (subtags.includes('hant')) return 'zh-TW'
  if (subtags.includes('hans')) return 'zh'
  return subtags.some(subtag => subtag === 'tw' || subtag === 'hk' || subtag === 'mo')
    ? 'zh-TW'
    : 'zh'
}

export function resolveSupportedLocale(languageTags: readonly string[]): Locale {
  for (const languageTag of languageTags) {
    const locale = mapLanguageTag(languageTag)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}

export function readStoredLocale(): Locale | null {
  try {
    const storage = browser.localStorage
    const stored = storage?.getItem(LOCALE_STORAGE_KEY) ?? null
    if (isLocale(stored)) return stored

    // 前身键一次性迁移：读到合法旧值后写新键。旧键不删除（前身应用仍可读）；
    // 新键一旦存在即优先，因此迁移不会覆盖用户后来在新应用里的选择。
    const legacy = storage?.getItem(LEGACY_LOCALE_STORAGE_KEY) ?? null
    if (!isLocale(legacy)) return null
    try {
      storage?.setItem?.(LOCALE_STORAGE_KEY, legacy)
    } catch {
      // 写入失败时仍按旧值生效，下次启动再尝试迁移。
    }
    return legacy
  } catch {
    // localStorage can be unavailable in locked-down browser contexts.
  }
  return null
}

export function getInitialLocale(): Locale {
  // 无用户偏好时默认中文（与主进程 DEFAULT_PREFERENCES 一致），
  // 不因系统语言为英文而首次落到 en；已保存的选择优先。
  return readStoredLocale()
    ?? initializedLocale
    ?? DEFAULT_LOCALE
}

export function applyDocumentLocale(locale: Locale): void {
  if (browser.document) browser.document.documentElement.lang = DOCUMENT_LANG[locale]
}

function applyResolvedLocale(locale: Locale): void {
  initializedLocale = locale
  applyDocumentLocale(locale)
  for (const listener of localeChangeListeners) listener(locale)
}

export function subscribeLocaleChanges(listener: (locale: Locale) => void): () => void {
  localeChangeListeners.add(listener)
  return () => {
    localeChangeListeners.delete(listener)
  }
}

export async function initializeLocale(
  runtime: LocaleRuntime,
): Promise<Locale> {
  try {
    await runtime.onLocaleChanged((locale) => {
      if (isLocale(locale)) applyResolvedLocale(locale)
    })
  } catch {
    // A host without event support can still initialize from the snapshot below.
  }

  const storedLocale = readStoredLocale()
  if (storedLocale) {
    try {
      await runtime.setLocalePreference(storedLocale)
    } catch {
      // localStorage remains the main-window compatibility source.
    }
    applyResolvedLocale(storedLocale)
    return storedLocale
  }

  try {
    const appPreference = await runtime.getLocalePreference()
    if (isLocale(appPreference)) {
      applyResolvedLocale(appPreference)
      return appPreference
    }
  } catch {
    // Fall through to system language detection.
  }

  let languageTags: string[] = []
  try {
    const preferredSystemLanguages = await runtime.getPreferredSystemLanguages()
    languageTags = preferredSystemLanguages.length > 0
      ? preferredSystemLanguages
      : readBrowserLanguages()
  } catch {
    languageTags = readBrowserLanguages()
  }

  const locale = resolveSupportedLocale(languageTags)
  applyResolvedLocale(locale)
  return locale
}
