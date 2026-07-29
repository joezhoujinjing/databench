import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { SelectInput } from '@/components/ui/input.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import {
  KeyValueGrid,
  KeyValueRow,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
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
import { GeneratedChartPanel } from '../../components/charts/GeneratedChartPanel.js'
import { formatRequestRate } from '../../domain/performance/view.js'
import { PerformanceRequests } from './PerformanceRequests.js'

export function PerformanceRuns({
  embedding,
  onPageChange,
  onRunChange,
  onStatusChange,
  page,
  path,
  run: selectedRun,
  status,
}: {
  readonly embedding: boolean
  readonly onPageChange: (page: number) => void
  readonly onRunChange: (run: string) => void
  readonly onStatusChange: (status: 'all' | 'failed' | 'success') => void
  readonly page: number
  readonly path: string
  readonly run: string | undefined
  readonly status: 'all' | 'failed' | 'success'
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryFn: ({ signal }) => evalScopeClient.request('perfRuns', { query: { path }, signal }),
    queryKey: ['evalscope', 'performance', path, 'runs'],
    retry: false,
  })
  const run = query.data?.runs.find((item) => item.dir_name === selectedRun) ?? query.data?.runs[0]
  useEffect(() => {
    if (run && selectedRun !== run.dir_name) onRunChange(run.dir_name)
  }, [onRunChange, run, selectedRun])
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.error)
    return (
      <Alert role="alert">
        {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')}
      </Alert>
    )
  if (!run) return <Alert role="status">{t('evaluations.performance.noRunsHint')}</Alert>
  const fallback = { columns: run.percentile_columns, rows: run.percentile_rows }
  return (
    <div className="space-y-4">
      <SelectInput
        aria-label={t('evaluations.performance.selectRun')}
        className="w-full max-w-xl"
        onValueChange={onRunChange}
        options={(query.data?.runs ?? []).map((item) => ({
          label: `${item.name} · C ${item.parallel} · ${item.number} req`,
          value: item.dir_name,
        }))}
        value={run.dir_name}
      />
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.performance.runConfig')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-4">
            <KeyValueRow label={t('evaluations.performance.concurrency')} value={run.parallel} />
            <KeyValueRow label={t('evaluations.performance.numberOfRequests')} value={run.number} />
            <KeyValueRow
              label={t('evaluations.performance.requestRate')}
              value={formatRequestRate(run.rate)}
            />
            <KeyValueRow
              label={t('evaluations.performance.successColumn')}
              value={`${run.succeed_requests}/${run.total_requests}`}
            />
          </KeyValueGrid>
        </SurfaceBody>
      </Surface>
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.performance.percentiles')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          {run.percentile_rows.length ? (
            <TableContainer aria-label={t('evaluations.performance.percentiles')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    {run.percentile_columns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.percentile_rows.map((row) => (
                    <TableRow key={JSON.stringify(row)}>
                      {run.percentile_columns.map((column, columnIndex) => (
                        <TableCell className="font-mono text-xs" key={column}>
                          {String(row[columnIndex] ?? '—')}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('evaluations.performance.noPercentile')}
            </p>
          )}
        </SurfaceBody>
      </Surface>
      {run.percentile_rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <GeneratedChartPanel
            fallback={fallback}
            load={(signal) =>
              evalScopeClient.request('perfChart', {
                query: { chart_type: 'percentile_latency', path, run: run.dir_name, theme: 'dark' },
                signal,
              })
            }
            queryKey={['evalscope', 'performance', path, run.dir_name, 'percentile_latency']}
            title={t('evaluations.performance.latencyPercentiles')}
          />
          {!embedding ? (
            <GeneratedChartPanel
              fallback={fallback}
              load={(signal) =>
                evalScopeClient.request('perfChart', {
                  query: { chart_type: 'percentile_token', path, run: run.dir_name, theme: 'dark' },
                  signal,
                })
              }
              queryKey={['evalscope', 'performance', path, run.dir_name, 'percentile_token']}
              title={t('evaluations.performance.tokenPercentiles')}
            />
          ) : null}
        </div>
      ) : null}
      <PerformanceRequests
        embedding={embedding}
        onPageChange={onPageChange}
        onStatusChange={onStatusChange}
        page={page}
        path={path}
        run={run.dir_name}
        status={status}
      />
    </div>
  )
}
