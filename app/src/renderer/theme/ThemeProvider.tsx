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
import { isPreferenceTheme } from '../../shared/ipc.ts'

export const THEMES = ['white', 'paper', 'warm-classic', 'celadon', 'ink-blue', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const THEME_STORAGE_KEY = 'cadre-heihei-theme'

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    // 存储不可读时回落到默认主题。
  }
  return 'white'
}

type ThemeContextValue = {
  theme: Theme
  setTheme: (next: Theme) => void
  /** prefs:set 失败（已保留原值）。 */
  preferenceError: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children, initialTheme }: { children: ReactNode; initialTheme?: Theme }) {
  const api = useCadreApi()
  const [theme, setThemeState] = useState<Theme>(() => initialTheme ?? readStoredTheme())
  const [preferenceError, setPreferenceError] = useState(false)

  const applyTheme = useCallback((next: Theme) => {
    setThemeState(next)
  }, [])

  // 主进程偏好为权威；读取失败时静默沿用缓存。
  useEffect(() => {
    if (!api.available) return
    let alive = true
    void api.getPreferences()
      .then((res) => {
        if (!alive || !res.ok) return
        if (isPreferenceTheme(res.theme)) applyTheme(res.theme)
      })
      .catch(() => {
        // 读取失败保留缓存。
      })
    return () => {
      alive = false
    }
  }, [api, applyTheme])

  const setTheme = useCallback((next: Theme) => {
    if (!api.available) {
      applyTheme(next)
      setPreferenceError(false)
      return
    }
    void api.setPreferences({ theme: next })
      .then((res) => {
        if (res.ok) {
          applyTheme(next)
          setPreferenceError(false)
        } else {
          setPreferenceError(true)
        }
      })
      .catch(() => setPreferenceError(true))
  }, [api, applyTheme])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // 存储不可写时仅本次会话生效。
    }
  }, [theme])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, preferenceError }),
    [theme, setTheme, preferenceError],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
