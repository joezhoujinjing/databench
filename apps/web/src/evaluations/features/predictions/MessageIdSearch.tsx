import { MessageSquare, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

export function MessageIdSearch({
  onSearch,
}: {
  readonly onSearch: (query: string) => string | null
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => setError(onSearch(query))
  return (
    <div>
      <div className="flex items-center gap-2">
        <label className="relative">
          <span className="sr-only">{t('evaluations.prediction.searchByMsgId')}</span>
          <MessageSquare
            aria-hidden="true"
            className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            size={12}
          />
          <input
            aria-invalid={error !== null}
            className={`h-9 w-48 rounded-[4px] border bg-background/45 pr-2 pl-7 text-sm outline-none ${error ? 'border-danger' : 'border-border focus:border-primary'}`}
            onChange={(event) => {
              setQuery(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
            placeholder={t('evaluations.prediction.searchByMsgId')}
            value={query}
          />
        </label>
        <Button
          aria-label={t('evaluations.prediction.searchByMsgId')}
          onClick={submit}
          size="sm"
          variant="outline"
        >
          <Search aria-hidden="true" size={13} />
        </Button>
      </div>
      {error ? (
        <p className="mt-1 text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
