import { ChevronLeft, ChevronRight, Hash, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

export function PredictionNavigator({
  current,
  indexValue,
  onIndexSearch,
  onNext,
  onPrevious,
  total,
}: {
  readonly current: number
  readonly indexValue?: string | undefined
  readonly onIndexSearch: (query: string) => Promise<string | null>
  readonly onNext: () => void
  readonly onPrevious: () => void
  readonly total: number
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const submit = async () => {
    setSearching(true)
    try {
      setError(await onIndexSearch(query))
    } catch (error) {
      setError(error instanceof Error ? error.message : t('evaluations.common.loadError'))
    } finally {
      setSearching(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Button
          aria-label={t('evaluations.prediction.previousSample')}
          disabled={current <= 1}
          onClick={onPrevious}
          size="sm"
          variant="outline"
        >
          <ChevronLeft aria-hidden="true" size={14} />
        </Button>
        <span className="inline-flex items-center gap-1 font-mono text-muted-foreground text-sm">
          <Hash aria-hidden="true" size={12} />
          {t('evaluations.prediction.samplePosition', { current, total })}
          {indexValue ? <span className="text-xs opacity-70">(index: {indexValue})</span> : null}
        </span>
        <Button
          aria-label={t('evaluations.prediction.nextSample')}
          disabled={current >= total}
          onClick={onNext}
          size="sm"
          variant="outline"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </Button>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <label className="relative">
            <span className="sr-only">{t('evaluations.prediction.searchByIndex')}</span>
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
              size={12}
            />
            <input
              aria-invalid={error !== null}
              className={`h-9 w-40 rounded-[4px] border bg-background/45 pr-2 pl-7 text-sm outline-none ${error ? 'border-danger' : 'border-border focus:border-primary'}`}
              onChange={(event) => {
                setQuery(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
              placeholder={t('evaluations.prediction.searchByIndex')}
              value={query}
            />
          </label>
          <Button disabled={searching} onClick={() => void submit()} size="sm" variant="outline">
            Go
          </Button>
        </div>
        {error ? (
          <p className="mt-1 text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
