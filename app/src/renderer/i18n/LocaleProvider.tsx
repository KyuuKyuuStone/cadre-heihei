import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { translate, type TextKey } from './index.ts'
import { applyDocumentLocale, getInitialLocale, LOCALE_STORAGE_KEY, type Locale } from './locale.ts'

export type Translator = (key: TextKey, params?: Record<string, string | number>) => string

type LocaleContextValue = {
  locale: Locale
  setLocale: (next: Locale) => void
  t: Translator
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? getInitialLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    applyDocumentLocale(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // 存储不可写时仅本次会话生效。
    }
  }, [])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
  }), [locale, setLocale])

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
