import { SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Surface } from '@/components/ui/surface.js'

export function PerformanceCatalogueState({
  error,
  filtered,
  onClear,
  onRetry,
}: {
  readonly error?: string | undefined
  readonly filtered: boolean
  readonly onClear: () => void
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  if (error)
    return (
      <Alert role="alert">
        <p>{error}</p>
        <Button className="mt-3" onClick={onRetry} size="sm" variant="outline">
          {t('evaluations.common.retry')}
        </Button>
      </Alert>
    )
  return (
    <Surface className="flex min-h-60 flex-col items-center justify-center px-6 py-10 text-center">
      <SearchX aria-hidden="true" className="text-muted-foreground" size={25} />
      <h2 className="mt-4 font-semibold">
        {t(filtered ? 'evaluations.dashboard.noMatch' : 'evaluations.performance.noData')}
      </h2>
      <p className="mt-2 text-muted-foreground text-sm">
        {t(filtered ? 'evaluations.dashboard.noMatchHint' : 'evaluations.performance.noRunsHint')}
      </p>
      {filtered ? (
        <Button className="mt-4" onClick={onClear} size="sm" variant="outline">
          {t('evaluations.benchmarks.clearFilters')}
        </Button>
      ) : null}
    </Surface>
  )
}
