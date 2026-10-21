import { useReducer } from 'react'
import type { TextKey } from '../i18n/index.ts'
import { VALID_LOCALES, isLocale, type Locale } from '../i18n/locale.ts'
import { useLocale } from '../i18n/LocaleProvider.tsx'
import { THEMES, useTheme, type Theme } from '../theme/ThemeProvider.tsx'
import { ConversationScreen } from '../screens/conversation/ConversationScreen.tsx'
import { LedgerScreen } from '../screens/ledger/LedgerScreen.tsx'
import { RosterScreen } from '../screens/roster/RosterScreen.tsx'
import { appReducer, type ScreenId } from './reducer.ts'

const NAV: ReadonlyArray<{ id: ScreenId; key: TextKey }> = [
  { id: 'conversation', key: 'nav.conversation' },
  { id: 'ledger', key: 'nav.ledger' },
  { id: 'roster', key: 'nav.roster' },
]

const THEME_LABEL_KEYS: Record<Theme, TextKey> = {
  white: 'theme.white',
  paper: 'theme.paper',
  'warm-classic': 'theme.warm-classic',
  celadon: 'theme.celadon',
  'ink-blue': 'theme.ink-blue',
  dark: 'theme.dark',
}

const LOCALE_LABEL_KEYS: Record<Locale, TextKey> = {
  en: 'locale.en',
  zh: 'locale.zh',
  'zh-TW': 'locale.zh-TW',
  jp: 'locale.jp',
  kr: 'locale.kr',
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, { screen: 'conversation' })
  const { t, locale, setLocale, preferenceError: localePrefError } = useLocale()
  const { theme, setTheme, preferenceError: themePrefError } = useTheme()

  return (
    <div className="app">
      <nav className="app__nav" aria-label={t('app.title')}>
        <div className="app__brand">{t('app.title')}</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className="app__nav-button"
            aria-current={state.screen === item.id ? 'page' : undefined}
            onClick={() => dispatch({ type: 'screen', screen: item.id })}
          >
            {t(item.key)}
          </button>
        ))}
      </nav>

      <div className="app__main">
        <header className="app__context">
          <span className="app__context-project">{t('app.context.project')}: —</span>

          <label className="app__select">
            <span>{t('app.theme.label')}</span>
            <select
              data-testid="theme-select"
              value={theme}
              onChange={(event) => setTheme(event.target.value as Theme)}
              aria-label={t('app.theme.label')}
            >
              {THEMES.map((value) => (
                <option key={value} value={value}>{t(THEME_LABEL_KEYS[value])}</option>
              ))}
            </select>
          </label>

          <label className="app__select">
            <span>{t('app.locale.label')}</span>
            <select
              data-testid="locale-select"
              value={locale}
              onChange={(event) => {
                const next = event.target.value
                if (isLocale(next)) setLocale(next)
              }}
              aria-label={t('app.locale.label')}
            >
              {VALID_LOCALES.map((value) => (
                <option key={value} value={value}>{t(LOCALE_LABEL_KEYS[value])}</option>
              ))}
            </select>
          </label>
        </header>

        {localePrefError || themePrefError ? (
          <div className="app__notice" role="status" data-testid="prefs-error">
            {t('prefs.error')}
          </div>
        ) : null}

        <main className="app__content">
          {state.screen === 'conversation' ? <ConversationScreen /> : null}
          {state.screen === 'ledger' ? <LedgerScreen /> : null}
          {state.screen === 'roster' ? <RosterScreen /> : null}
        </main>
      </div>
    </div>
  )
}
