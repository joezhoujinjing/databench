import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Radar, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
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
import { SafeGeneratedDocumentFrame } from '../../components/SafeGeneratedDocumentFrame.js'
import { boundedMetricRatio, formatMetricValue, metricSupportsRadar } from '../../domain/metric.js'
import { reportOverviewRows } from '../../domain/reports.js'

export function OverviewTab({
  onDatasetClick,
  reportName,
  reports,
  taskConfig,
}: {
  readonly onDatasetClick: (dataset: string) => void
  readonly reportName: string
  readonly reports: readonly ReportData[]
  readonly taskConfig: Record<string, unknown>
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'radar' | 'table'>('table')
  const [sort, setSort] = useState<{ key: 'dataset' | 'samples' | 'score'; order: 'asc' | 'desc' }>(
    { key: 'score', order: 'desc' },
  )
  const rows = useMemo(
    () =>
      reportOverviewRows(reports).sort((left, right) => {
        const value =
          sort.key === 'dataset'
            ? left.dataset.localeCompare(right.dataset)
            : left[sort.key] - right[sort.key]
        return sort.order === 'asc' ? value : -value
      }),
    [reports, sort],
  )
  const canRadar = metricSupportsRadar(rows.map((row) => row.metric))
  const chart = useQuery({
    enabled: view === 'radar' && canRadar,
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsChart', {
        query: { chart_type: 'radar', report_name: reportName, theme: 'dark' },
        signal,
      }),
    queryKey: ['evalscope', 'report-radar', reportName],
    retry: false,
  })
  const toggleSort = (key: typeof sort.key) =>
    setSort((current) => ({
      key,
      order: current.key === key && current.order === 'desc' ? 'asc' : 'desc',
    }))
  const table = (
    <TableContainer aria-label={t('evaluations.single.datasetScores')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              aria-sort={
                sort.key === 'dataset'
                  ? sort.order === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
            >
              <button onClick={() => toggleSort('dataset')} type="button">
                Dataset
              </button>
            </TableHead>
            <TableHead
              aria-sort={
                sort.key === 'score' ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'
              }
            >
              <button onClick={() => toggleSort('score')} type="button">
                Score
              </button>
            </TableHead>
            <TableHead
              aria-sort={
                sort.key === 'samples'
                  ? sort.order === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
              className="text-right"
            >
              <button onClick={() => toggleSort('samples')} type="button">
                Samples
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.dataset}>
              <TableCell>
                <button
                  className="font-medium text-primary hover:underline"
                  onClick={() => onDatasetClick(row.dataset)}
                  type="button"
                >
                  {row.dataset}
                </button>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-3">
                  {boundedMetricRatio(row.metric, row.score) !== null ? (
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
                      <span
                        className="block h-full bg-primary"
                        style={{
                          width: `${(boundedMetricRatio(row.metric, row.score) ?? 0) * 100}%`,
                        }}
                      />
                    </span>
                  ) : null}
                  <span className="font-mono">
                    {formatMetricValue(row.metric, row.score).primary}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.samples.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
  return (
    <div className="space-y-5">
      <Surface>
        <SurfaceHeader className="flex items-center justify-between">
          <SurfaceTitle>{t('evaluations.single.datasetScores')}</SurfaceTitle>
          {canRadar ? (
            <div className="flex gap-1">
              <Button
                aria-pressed={view === 'table'}
                onClick={() => setView('table')}
                size="sm"
                variant={view === 'table' ? 'default' : 'ghost'}
              >
                <Table2 aria-hidden="true" size={14} />
                {t('evaluations.single.tableView')}
              </Button>
              <Button
                aria-pressed={view === 'radar'}
                onClick={() => setView('radar')}
                size="sm"
                variant={view === 'radar' ? 'default' : 'ghost'}
              >
                <Radar aria-hidden="true" size={14} />
                {t('evaluations.single.radarView')}
              </Button>
            </div>
          ) : null}
        </SurfaceHeader>
        <SurfaceBody>
          {view === 'radar' && canRadar ? (
            chart.error ? (
              <Alert className="border-danger/30" role="alert">
                {chart.error instanceof Error
                  ? chart.error.message
                  : t('evaluations.common.loadError')}
              </Alert>
            ) : chart.data ? (
              <>
                <SafeGeneratedDocumentFrame
                  className="min-h-[26rem] w-full rounded-[5px] border border-border bg-white"
                  document={chart.data}
                  title={t('evaluations.single.radarView')}
                />
                <div className="sr-only">{table}</div>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t('evaluations.common.loading')}</p>
            )
          ) : (
            table
          )}
        </SurfaceBody>
      </Surface>
      {Object.keys(taskConfig).length > 0 ? (
        <details className="rounded-[6px] border border-border bg-surface/70">
          <summary className="flex min-h-12 cursor-pointer items-center gap-2 px-4 font-medium">
            <ChevronDown aria-hidden="true" size={14} />
            {t('evaluations.reportDetail.taskConfig')}
          </summary>
          <pre className="max-h-[30rem] overflow-auto border-border border-t bg-background/45 p-4 font-mono text-xs">
            {JSON.stringify(taskConfig, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  )
}
