import { Link } from '@tanstack/react-router'
import { SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'

export function ReportsState({
  error,
  hasFilters,
  onClear,
  onRetry,
}: {
  readonly error?: string | undefined
  readonly hasFilters: boolean
  readonly onClear: () => void
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  if (error)
    return (
      <Alert className="border-danger/30 py-7" role="alert">
        <h2 className="font-semibold">{t('evaluations.empty.load-error.message')}</h2>
        <p className="mt-2 text-muted-foreground text-sm">{error}</p>
        <Button className="mt-4" onClick={onRetry} size="sm" variant="outline">
          {t('evaluations.empty.action.retry')}
        </Button>
      </Alert>
    )
  return (
    <div className="border-border border-y py-12 text-center">
      <SearchX aria-hidden="true" className="mx-auto text-muted-foreground" size={24} />
      <h2 className="mt-3 font-semibold">
        {t(hasFilters ? 'evaluations.empty.no-match.message' : 'evaluations.empty.no-data.message')}
      </h2>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {hasFilters ? (
          <Button onClick={onClear} size="sm" variant="outline">
            {t('evaluations.empty.action.clearFilters')}
          </Button>
        ) : (
          <>
            <Button asChild size="sm">
              <Link search={{ tab: 'eval' }} to="/evaluations/tasks">
                {t('evaluations.empty.action.createTask')}
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/evaluations/benchmarks">
                {t('evaluations.empty.action.browseBenchmarks')}
              </Link>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
