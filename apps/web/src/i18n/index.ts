import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const LANGUAGE_STORAGE_KEY = 'databench.lang'

void i18next.use(initReactI18next).init({
  debug: false,
  fallbackLng: 'zh',
  lng: readStoredLanguage() ?? 'zh',
  interpolation: {
    escapeValue: false,
  },
  load: 'languageOnly',
  nonExplicitSupportedLngs: true,
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  showSupportNotice: false,
  supportedLngs: [...SUPPORTED_LANGUAGES],
})

i18next.on('languageChanged', (language) => {
  const normalized = normalizeLanguage(language)

  if (normalized === undefined || typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized)
  } catch {
    // localStorage can be unavailable in locked-down embeds.
  }
})

export function normalizeLanguage(language: string | null | undefined): Language | undefined {
  const base = language?.split('-')[0]

  return SUPPORTED_LANGUAGES.find((supported) => supported === base)
}

function readStoredLanguage(): Language | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  try {
    return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export default i18next
