import { Check, ChevronDown, Globe2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'

const SUPPORTED_LANGUAGES = [
  { label: 'EN', value: 'en' },
  { label: '中文', value: 'zh' },
] as const

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current = i18n.resolvedLanguage ?? i18n.language
  const active = SUPPORTED_LANGUAGES.find((language) => current.startsWith(language.value))
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('language.label')}
        className="flex h-10 items-center gap-2 rounded-[5px] px-2 text-base text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Globe2 aria-hidden="true" size={17} />
        <span className="max-sm:sr-only">{active?.label ?? current}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {open ? (
        <div
          aria-label={t('language.label')}
          className="absolute right-0 z-20 mt-3 min-w-32 rounded-[5px] border border-border bg-surface-raised p-1.5 text-sm shadow-2xl"
          role="menu"
        >
          {SUPPORTED_LANGUAGES.map((language) => {
            const selected = current.startsWith(language.value)
            return (
              <button
                aria-checked={selected}
                className={cn(
                  'flex w-full items-center justify-between gap-4 rounded-[3px] px-3 py-2 text-left text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                  selected && 'text-foreground',
                )}
                key={language.value}
                onClick={() => {
                  void i18n.changeLanguage(language.value)
                  setOpen(false)
                }}
                role="menuitemradio"
                type="button"
              >
                {language.label}
                {selected ? <Check aria-hidden="true" className="text-primary" size={14} /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
