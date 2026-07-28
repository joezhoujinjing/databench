import { Link } from '@tanstack/react-router'
import { ExternalLink, GitCompareArrows, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { evalScopeClient } from '../../api/client.js'
import type { GeneratedDocumentDescriptor } from '../../api/schemas.js'
import { encodeReportKey } from '../../domain/report-key.js'
import { MAX_REPORT_SELECTION } from '../../domain/reports.js'
import { taskViewerHref } from '../../hooks/use-task-runner.js'

export function ReportSelectionTray({
  capReached,
  onClear,
  selected,
}: {
  readonly capReached: boolean
  readonly onClear: () => void
  readonly selected: readonly string[]
}) {
  const { t } = useTranslation()
  const [document, setDocument] = useState<GeneratedDocumentDescriptor | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  if (selected.length === 0) return null
  const loadHtml = async () => {
    if (selected.length !== 1) return
    setLoading(true)
    setError('')
    try {
      setDocument(
        await evalScopeClient.request('reportsHtml', { query: { report_name: selected[0] } }),
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('evaluations.common.loadError'))
    } finally {
      setLoading(false)
    }
  }
  const compareSearch = selected.slice(0, 3).map(encodeReportKey).join(';')
  return (
    <div className="sticky bottom-3 z-20 rounded-[6px] border border-primary/35 bg-surface/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-sm">
          {selected.length} {t('evaluations.reports.selected')}{' '}
          <span className="font-normal text-muted-foreground">/ {MAX_REPORT_SELECTION}</span>
        </strong>
        {capReached ? (
          <span className="text-warning text-xs" role="status">
            {t('evaluations.reports.capReached')}
          </span>
        ) : null}
        {selected.length > 3 ? (
          <span className="text-warning text-xs">{t('evaluations.compare.maxThreeSelected')}</span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {document ? (
            <Button asChild size="sm" variant="outline">
              <a href={taskViewerHref(document)} rel="noopener noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={14} />
                {t('evaluations.reports.viewHtml')}
              </a>
            </Button>
          ) : (
            <Button
              disabled={selected.length !== 1 || loading}
              onClick={() => void loadHtml()}
              size="sm"
              variant="outline"
            >
              {loading ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
              ) : (
                <ExternalLink aria-hidden="true" size={14} />
              )}
              {t('evaluations.reports.viewHtml')}
            </Button>
          )}
          {selected.length >= 2 ? (
            <Button asChild size="sm">
              <Link search={{ reports: compareSearch }} to="/evaluations/compare">
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
            <X aria-hidden="true" size={15} />
          </Button>
        </div>
      </div>
      {error ? (
        <Alert className="mt-3 border-danger/30 text-danger" role="alert">
          {error}
        </Alert>
      ) : null}
    </div>
  )
}
