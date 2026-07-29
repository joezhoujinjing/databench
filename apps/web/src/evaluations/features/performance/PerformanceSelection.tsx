import { Link } from '@tanstack/react-router'
import { ExternalLink, GitCompareArrows, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { evalScopeClient } from '../../api/client.js'
import type { GeneratedDocumentDescriptor, PerfRunSummary } from '../../api/schemas.js'
import { encodeReportKey } from '../../domain/report-key.js'
import { taskViewerHref } from '../../hooks/use-task-runner.js'

export function PerformanceSelection({
  onClear,
  runs,
  selected,
}: {
  readonly onClear: () => void
  readonly runs: readonly PerfRunSummary[]
  readonly selected: readonly string[]
}) {
  const { t } = useTranslation()
  const [document, setDocument] = useState<GeneratedDocumentDescriptor | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  if (!selected.length) return null
  const selectedRun =
    selected.length === 1 ? runs.find((run) => run.path === selected[0]) : undefined
  const compareRuns = selected.slice(0, 3).map(encodeReportKey).join(';')
  const loadHtml = async () => {
    if (!selectedRun?.has_html) return
    setLoading(true)
    setError('')
    try {
      setDocument(
        await evalScopeClient.request('perfHistoryReport', { query: { path: selectedRun.path } }),
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('evaluations.common.loadError'))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="sticky bottom-3 z-20 rounded-[6px] border border-primary/35 bg-surface/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-sm">
          {selected.length} {t('evaluations.reports.selected')}{' '}
          <span className="font-normal text-muted-foreground">/ 5</span>
        </strong>
        {selected.length > 3 ? (
          <span className="text-warning text-xs">{t('evaluations.compare.maxThreeSelected')}</span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {document ? (
            <Button asChild size="sm" variant="outline">
              <a href={taskViewerHref(document)} rel="noopener noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={14} />
                {t('evaluations.performance.viewFullHtml')}
              </a>
            </Button>
          ) : (
            <Button
              disabled={!selectedRun?.has_html || loading}
              onClick={() => void loadHtml()}
              size="sm"
              variant="outline"
            >
              {loading ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
              ) : (
                <ExternalLink aria-hidden="true" size={14} />
              )}
              {t('evaluations.performance.viewFullHtml')}
            </Button>
          )}
          {selected.length >= 2 ? (
            <Button asChild size="sm">
              <Link
                search={{ embedding: 0, runs: compareRuns }}
                to="/evaluations/performance/compare"
              >
                <GitCompareArrows aria-hidden="true" size={14} />
                {t('evaluations.reports.compare')}
              </Link>
            </Button>
          ) : (
            <Button disabled size="sm">
              <GitCompareArrows aria-hidden="true" size={14} />
              {t('evaluations.reports.compare')}
            </Button>
          )}
          <Button
            aria-label={t('evaluations.reports.clearSelection')}
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} />
          </Button>
        </div>
      </div>
      {error ? (
        <Alert className="mt-3 border-danger/30" role="alert">
          {error}
        </Alert>
      ) : null}
    </div>
  )
}
