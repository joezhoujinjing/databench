import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'

const SUPPORTED_LANGUAGES = [
  { label: 'EN', value: 'en' },
  { label: '中文', value: 'zh' },
] as const

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current = i18n.resolvedLanguage ?? i18n.language

  return (
    <fieldset className="flex overflow-hidden rounded-[5px] border border-border bg-background">
      <legend className="sr-only">{t('language.label')}</legend>
      {SUPPORTED_LANGUAGES.map((language) => (
        <button
          aria-pressed={current.startsWith(language.value)}
          className={cn(
            'h-8 px-3 text-muted-foreground text-sm transition hover:bg-surface-hover hover:text-foreground',
            current.startsWith(language.value) && 'bg-accent text-accent-foreground',
          )}
          key={language.value}
          onClick={() => void i18n.changeLanguage(language.value)}
          type="button"
        >
          {t(`language.${language.value}`)}
        </button>
      ))}
    </fieldset>
  )
}
