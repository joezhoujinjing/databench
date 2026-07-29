import { Link } from '@tanstack/react-router'
import { ArrowLeft, Boxes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { MetricItem, MetricStrip, PageHeader } from '@/components/ui/surface.js'
import type { ReportData } from '../../api/schemas.js'
import { formatMetricValue } from '../../domain/metric.js'
import { summarizeReportData } from '../../domain/reports.js'
import { ReportDocument } from './ReportDocument.js'

export function ReportHeader({
  activeDataset,
  datasets,
  onDatasetChange,
  reportName,
  reports,
}: {
  readonly activeDataset: string
  readonly datasets: readonly string[]
  readonly onDatasetChange: (dataset: string) => void
  readonly reportName: string
  readonly reports: readonly ReportData[]
}) {
  const { t } = useTranslation()
  const stats = summarizeReportData(reports)
  const model = reports[0]?.model_name ?? reportName
  return (
    <div className="space-y-5">
      <PageHeader
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/evaluations/reports">
              <ArrowLeft aria-hidden="true" size={14} />
              {t('evaluations.reportDetail.backToReports')}
            </Link>
          </Button>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Boxes aria-hidden="true" size={14} />
            {datasets.map((dataset) => (
              <button
                className={`rounded-[4px] border px-2 py-1 text-sm ${dataset === activeDataset ? 'border-primary/50 bg-primary/8 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                key={dataset}
                onClick={() => onDatasetChange(dataset)}
                type="button"
              >
                {dataset}
              </button>
            ))}
          </span>
        }
        eyebrow={<Badge tone="accent">EvalScope report</Badge>}
        title={model}
      />
      {stats ? (
        <MetricStrip className="lg:grid-cols-4">
          <MetricItem
            label={t('evaluations.reportDetail.avgScore')}
            value={
              stats.average === null
                ? '—'
                : formatMetricValue(stats.metricName, stats.average).primary
            }
          />
          <MetricItem
            label={t('evaluations.reportDetail.bestDataset')}
            value={
              stats.best ? (
                <>
                  <strong className="font-mono">
                    {formatMetricValue(stats.metricName, stats.best.score).primary}
                  </strong>
                  <span className="ml-2 text-muted-foreground text-sm">{stats.best.dataset}</span>
                </>
              ) : (
                '—'
              )
            }
          />
          <MetricItem
            label={t('evaluations.reportDetail.worstDataset')}
            value={
              stats.worst ? (
                <>
                  <strong className="font-mono">
                    {formatMetricValue(stats.metricName, stats.worst.score).primary}
                  </strong>
                  <span className="ml-2 text-muted-foreground text-sm">{stats.worst.dataset}</span>
                </>
              ) : (
                '—'
              )
            }
          />
          <MetricItem
            label={t('evaluations.reportDetail.totalSamples')}
            value={<strong className="font-mono">{stats.totalSamples.toLocaleString()}</strong>}
          />
        </MetricStrip>
      ) : null}
      <ReportDocument reportName={reportName} />
    </div>
  )
}
