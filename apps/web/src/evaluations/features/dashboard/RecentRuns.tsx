import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, FileText, Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Surface } from '@/components/ui/surface.js'
import type { DashboardRun } from '../../domain/dashboard.js'
import { formatMetricValue } from '../../domain/metric.js'

function shortTimestamp(timestamp: string): string {
  if (!timestamp) return '—'
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
    : timestamp.replace('T', ' ').slice(0, 16)
}

export function RecentRuns({
  items,
  onPageChange,
  page,
  totalPages,
  totalResults,
}: {
  readonly items: readonly DashboardRun[]
  readonly onPageChange: (page: number) => void
  readonly page: number
  readonly totalPages: number
  readonly totalResults: number
}) {
  const { t } = useTranslation()
  return (
    <Surface aria-label={t('evaluations.dashboard.recentRuns')}>
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <h2 className="font-semibold">{t('evaluations.dashboard.recentRuns')}</h2>
        <Badge tone="muted">{totalResults}</Badge>
      </div>
      <div className="divide-y divide-border">
        <div className="hidden grid-cols-[2.5rem_minmax(10rem,1fr)_minmax(10rem,1.3fr)_11rem_7rem_1.5rem] gap-3 px-4 py-2 text-muted-foreground text-xs md:grid">
          <span />
          <span>{t('evaluations.dashboard.model')}</span>
          <span>{t('evaluations.dashboard.dataset')}</span>
          <span>{t('evaluations.dashboard.date')}</span>
          <span className="text-right">{t('evaluations.dashboard.result')}</span>
          <span />
        </div>
        {items.map((item) => {
          const isEvaluation = item.kind === 'eval'
          const model = isEvaluation ? item.report.model_name : item.run.model
          const dataset = isEvaluation
            ? item.report.dataset_name
            : item.run.dataset || item.run.api_type
          const result = isEvaluation
            ? formatMetricValue(item.report.metric_name ?? 'score', item.report.score).primary
            : formatMetricValue('rps', item.run.best_rps).primary
          const content = (
            <>
              <span className="flex size-8 items-center justify-center rounded-[5px] border border-border bg-background/55 text-primary">
                {isEvaluation ? (
                  <FileText aria-hidden="true" size={15} />
                ) : (
                  <Gauge aria-hidden="true" size={15} />
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm">{model}</span>
                <span className="block truncate font-mono text-muted-foreground text-xs md:hidden">
                  {dataset}
                </span>
              </span>
              <span className="hidden min-w-0 md:block">
                <span className="block truncate text-sm">{dataset || '—'}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  {isEvaluation
                    ? `${item.report.num_samples.toLocaleString()} ${t('evaluations.dashboard.samples')}`
                    : `${item.run.num_runs.toLocaleString()} ${t('evaluations.dashboard.runs')}`}
                </span>
              </span>
              <span className="hidden text-muted-foreground text-xs md:block">
                {shortTimestamp(item.timestamp)}
              </span>
              <span className="text-right font-mono text-sm">{result}</span>
              <ChevronRight
                aria-hidden="true"
                className="hidden text-muted-foreground group-hover:text-foreground md:block"
                size={14}
              />
            </>
          )
          const className =
            'group grid min-h-14 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary md:grid-cols-[2.5rem_minmax(10rem,1fr)_minmax(10rem,1.3fr)_11rem_7rem_1.5rem]'
          return isEvaluation ? (
            <Link
              className={className}
              key={`eval:${item.report.name}`}
              params={{ reportKey: item.report.name }}
              to="/evaluations/reports/$reportKey"
            >
              {content}
            </Link>
          ) : (
            <Link
              className={className}
              key={`perf:${item.run.path}`}
              params={{ performanceKey: item.run.path }}
              to="/evaluations/performance/$performanceKey"
            >
              {content}
            </Link>
          )
        })}
      </div>
      <div className="flex items-center justify-between border-border border-t px-4 py-3">
        <span className="font-mono text-muted-foreground text-xs">
          {page} / {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            aria-label={t('evaluations.prediction.previousSample')}
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            size="sm"
            variant="outline"
          >
            <ChevronLeft aria-hidden="true" size={14} />
          </Button>
          <Button
            aria-label={t('evaluations.prediction.nextSample')}
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            size="sm"
            variant="outline"
          >
            <ChevronRight aria-hidden="true" size={14} />
          </Button>
        </div>
      </div>
    </Surface>
  )
}
