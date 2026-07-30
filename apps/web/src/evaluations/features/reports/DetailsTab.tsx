import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { Surface, SurfaceBody, SurfaceHeader, SurfaceTitle } from '@/components/ui/surface.js'
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { evalScopeClient } from '../../api/client.js'
import type { ReportData } from '../../api/schemas.js'
import { boundedMetricRatio, formatMetricValue } from '../../domain/metric.js'
import { resolvePrimaryMetric, subsetRows } from '../../domain/reports.js'
import { RichContent } from '../content/RichContent.js'
import { PerfMetricsPanel } from './PerfMetricsPanel.js'

export function DetailsTab({
  datasetName,
  onSubsetClick,
  report,
  reportName,
}: {
  readonly datasetName: string
  readonly onSubsetClick: (subset: string) => void
  readonly report?: ReportData | undefined
  readonly reportName: string
}) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<{
    key: 'metric' | 'samples' | 'score' | 'subset'
    order: 'asc' | 'desc'
  }>({ key: 'score', order: 'desc' })
  const query = useQuery({
    enabled: datasetName !== '',
    queryFn: async ({ signal }) => {
      const [analysis, frame] = await Promise.all([
        evalScopeClient.request('reportsAnalysis', {
          query: { dataset_name: datasetName, report_name: reportName },
          signal,
        }),
        evalScopeClient.request('reportsDataFrame', {
          query: { dataset_name: datasetName, report_name: reportName, type: 'dataset' },
          signal,
        }),
      ])
      return { analysis: analysis.analysis, frame }
    },
    queryKey: ['evalscope', 'report-details', reportName, datasetName],
    retry: false,
  })
  const rows = useMemo(
    () =>
      subsetRows(query.data?.frame ?? { columns: [], data: [] }).sort((left, right) => {
        const value =
          sort.key === 'subset' || sort.key === 'metric'
            ? left[sort.key].localeCompare(right[sort.key])
            : left[sort.key] - right[sort.key]
        return sort.order === 'asc' ? value : -value
      }),
    [query.data?.frame, sort],
  )
  const toggleSort = (key: typeof sort.key) =>
    setSort((current) => ({
      key,
      order: current.key === key && current.order === 'desc' ? 'asc' : 'desc',
    }))
  const metricName = report ? (resolvePrimaryMetric(report)?.name ?? 'score') : 'score'
  const ratio = boundedMetricRatio(metricName, report?.score)
  if (query.isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-56" />
      </div>
    )
  if (query.error)
    return (
      <Alert className="border-danger/30" role="alert">
        {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')}
      </Alert>
    )
  return (
    <div className="space-y-5">
      {report ? (
        <div className="flex items-center gap-4 rounded-[6px] border border-border bg-surface/70 p-4">
          <div>
            <p className="text-muted-foreground text-xs uppercase tracking-[0.1em]">
              {t('evaluations.reportDetail.overallScore')}
            </p>
            <strong className="mt-2 block font-mono text-3xl">
              {formatMetricValue(metricName, report.score).primary}
            </strong>
          </div>
          {ratio !== null ? (
            <div
              aria-label={t('evaluations.reportDetail.overallScore')}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(ratio * 100)}
              className="ml-auto size-16 rounded-full border-[7px] border-primary/25"
              role="progressbar"
            >
              <span className="sr-only">{ratio * 100}%</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.reportDetail.subsetScores')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('evaluations.common.noData')}</p>
          ) : (
            <TableContainer aria-label={t('evaluations.reportDetail.subsetScores')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    {(['subset', 'metric', 'score', 'samples'] as const).map((key) => (
                      <TableHead
                        aria-sort={
                          sort.key === key
                            ? sort.order === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className={key === 'samples' ? 'text-right' : undefined}
                        key={key}
                      >
                        <button onClick={() => toggleSort(key)} type="button">
                          {key === 'subset'
                            ? 'Subset'
                            : key === 'metric'
                              ? t('evaluations.reportDetail.metric')
                              : key === 'score'
                                ? 'Score'
                                : 'Num'}
                        </button>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.subset}>
                      <TableCell>
                        <button
                          className="font-medium text-primary hover:underline"
                          onClick={() => onSubsetClick(row.subset)}
                          title={t('evaluations.reportDetail.viewPredictions')}
                          type="button"
                        >
                          {row.subset}
                        </button>
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground text-xs">
                        {row.metric}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono">
                          {formatMetricValue(row.metric, row.score).primary}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.samples.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </SurfaceBody>
      </Surface>
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.reportDetail.analysis')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          {query.data?.analysis && query.data.analysis !== 'N/A' ? (
            <RichContent content={query.data.analysis} />
          ) : (
            <p className="text-muted-foreground text-sm">{t('evaluations.common.noData')}</p>
          )}
        </SurfaceBody>
      </Surface>
      {report?.perf_metrics ? (
        <Surface>
          <SurfaceHeader>
            <SurfaceTitle>{t('evaluations.reportDetail.perfMetrics')}</SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody>
            <PerfMetricsPanel metrics={report.perf_metrics} />
          </SurfaceBody>
        </Surface>
      ) : null}
    </div>
  )
}
