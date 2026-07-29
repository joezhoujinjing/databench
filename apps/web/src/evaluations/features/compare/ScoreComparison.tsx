import { useQuery } from '@tanstack/react-query'
import { BarChart3, Radar, Table2 } from 'lucide-react'
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
import { SafeGeneratedDocumentFrame } from '../../components/SafeGeneratedDocumentFrame.js'
import type { TaggedReportData } from '../../domain/compare.js'
import { formatMetricValue, metricSupportsRadar } from '../../domain/metric.js'

export function ScoreComparison({
  commonDatasets,
  reportNames,
  rows,
}: {
  readonly commonDatasets: readonly string[]
  readonly reportNames: readonly string[]
  readonly rows: readonly TaggedReportData[]
}) {
  const { t } = useTranslation()
  const [visualization, setVisualization] = useState<'chart' | 'table'>('table')
  const metric = rows[0]?.metrics[0]?.name ?? 'score'
  const supportsRadar = metricSupportsRadar(commonDatasets.map(() => metric))
  const chartType = supportsRadar ? 'radar' : 'grouped_bar'
  const chart = useQuery({
    enabled: visualization === 'chart' && reportNames.length >= 2,
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsChart', {
        query: { chart_type: chartType, report_names: reportNames.join(';'), theme: 'dark' },
        signal,
      }),
    queryKey: ['evalscope', 'compare', 'chart', chartType, reportNames.join(';')],
    retry: false,
  })
  const scores = useMemo(
    () =>
      Object.fromEntries(
        reportNames.map((name) => [
          name,
          new Map(
            rows
              .filter((row) => row.reportName === name)
              .map((row) => [row.dataset_name, row] as const),
          ),
        ]),
      ),
    [reportNames, rows],
  )
  const table = (
    <TableContainer aria-label={t('evaluations.compare.scoreComparison')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('evaluations.compare.dataset')}</TableHead>
            {reportNames.map((name) => (
              <TableHead className="text-right" key={name}>
                {rows.find((row) => row.reportName === name)?.model_name ?? name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="bg-primary/5 font-semibold">
            <TableCell>{t('evaluations.compare.average')}</TableCell>
            {reportNames.map((name) => {
              const values = commonDatasets.flatMap((dataset) => {
                const value = scores[name]?.get(dataset)?.score
                return value === undefined ? [] : [value]
              })
              const average = values.length
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null
              return (
                <TableCell className="text-right font-mono" key={name}>
                  {formatMetricValue(metric, average).primary}
                </TableCell>
              )
            })}
          </TableRow>
          {commonDatasets.map((dataset) => (
            <TableRow key={dataset}>
              <TableCell className="font-medium">{dataset}</TableCell>
              {reportNames.map((name) => {
                const row = scores[name]?.get(dataset)
                return (
                  <TableCell className="text-right font-mono" key={name}>
                    {formatMetricValue(row?.metrics[0]?.name ?? metric, row?.score).primary}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
  return (
    <Surface>
      <SurfaceHeader className="flex flex-wrap items-center justify-between gap-3">
        <SurfaceTitle>{t('evaluations.compare.scoreComparison')}</SurfaceTitle>
        <div className="flex gap-1">
          <Button
            aria-pressed={visualization === 'table'}
            onClick={() => setVisualization('table')}
            size="sm"
            variant={visualization === 'table' ? 'default' : 'ghost'}
          >
            <Table2 aria-hidden="true" size={14} />
            {t('evaluations.single.tableView')}
          </Button>
          <Button
            aria-pressed={visualization === 'chart'}
            onClick={() => setVisualization('chart')}
            size="sm"
            variant={visualization === 'chart' ? 'default' : 'ghost'}
          >
            {supportsRadar ? (
              <Radar aria-hidden="true" size={14} />
            ) : (
              <BarChart3 aria-hidden="true" size={14} />
            )}
            {supportsRadar
              ? t('evaluations.single.radarView')
              : t('evaluations.performance.charts')}
          </Button>
        </div>
      </SurfaceHeader>
      <SurfaceBody>
        {visualization === 'table' ? (
          table
        ) : chart.error ? (
          <Alert role="alert">
            {chart.error instanceof Error ? chart.error.message : t('evaluations.charts.loadError')}
          </Alert>
        ) : chart.data ? (
          <>
            <SafeGeneratedDocumentFrame
              className="min-h-[30rem] w-full rounded-[5px] border border-border bg-white"
              document={chart.data}
              title={t('evaluations.compare.scoreComparison')}
            />
            <div className="sr-only">{table}</div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">{t('evaluations.common.loading')}</p>
        )}
      </SurfaceBody>
    </Surface>
  )
}
