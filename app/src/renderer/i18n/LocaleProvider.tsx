import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useCadreApi } from '../data/CadreApiProvider.tsx'
import { isPreferenceLocale } from '../../shared/ipc.ts'
import { translate, type TextKey } from './index.ts'
import { applyDocumentLocale, getInitialLocale, LOCALE_STORAGE_KEY, type Locale } from './locale.ts'

export type Translator = (key: TextKey, params?: Record<string, string | number>) => string

type LocaleContextValue = {
  locale: Locale
  setLocale: (next: Locale) => void
  t: Translator
  /** prefs:set 失败（已保留原值）。 */
  preferenceError: boolean
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const api = useCadreApi()
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? getInitialLocale())
  const [preferenceError, setPreferenceError] = useState(false)

  const applyLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    applyDocumentLocale(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // 存储不可写时仅本次会话生效。
    }
  }, [])

  // 主进程偏好为权威；localStorage 只是启动缓存。读取失败时静默沿用缓存。
  useEffect(() => {
    if (!api.available) return
    let alive = true
    void api.getPreferences()
      .then((res) => {
        if (!alive || !res.ok) return
        if (isPreferenceLocale(res.locale)) applyLocale(res.locale)
      })
      .catch(() => {
        // 读取失败不打扰用户，保留缓存值。
      })
    return () => {
      alive = false
    }
  }, [api, applyLocale])

  const setLocale = useCallback((next: Locale) => {
    if (!api.available) {
      applyLocale(next)
      setPreferenceError(false)
      return
    }
    void api.setPreferences({ locale: next })
      .then((res) => {
        if (res.ok) {
          applyLocale(next)
          setPreferenceError(false)
        } else {
          // 保留旧值，仅提示。
          setPreferenceError(true)
        }
      })
      .catch(() => setPreferenceError(true))
  }, [api, applyLocale])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    preferenceError,
  }), [locale, setLocale, preferenceError])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale 必须在 LocaleProvider 内使用')
  return ctx
}

/** 前身 `useTranslation` 的等价重写：返回绑定当前 locale 的 t()。 */
export function useTranslation(): Translator {
  return useLocale().t
}
