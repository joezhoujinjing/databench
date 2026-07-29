import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
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
import { GeneratedChartPanel } from '../../components/charts/GeneratedChartPanel.js'

const PAGE_SIZE = 50

export function PerformanceRequests({
  embedding,
  onPageChange,
  onStatusChange,
  page,
  path,
  run,
  status,
}: {
  readonly embedding: boolean
  readonly onPageChange: (page: number) => void
  readonly onStatusChange: (status: 'all' | 'failed' | 'success') => void
  readonly page: number
  readonly path: string
  readonly run: string
  readonly status: 'all' | 'failed' | 'success'
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryFn: ({ signal }) =>
      evalScopeClient.request('perfRequests', {
        query: {
          page,
          page_size: PAGE_SIZE,
          path,
          run,
          status: status === 'all' ? undefined : status,
        },
        signal,
      }),
    queryKey: ['evalscope', 'performance', path, 'requests', run, status, page],
    retry: false,
  })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.error)
    return (
      <Alert role="alert">
        {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')}
      </Alert>
    )
  if (!query.data?.has_db)
    return (
      <Alert role="status">
        <strong>{t('evaluations.performance.noDb')}</strong>
        <span className="ml-2 text-muted-foreground">{t('evaluations.performance.noDbHint')}</span>
      </Alert>
    )
  const totalPages = Math.max(1, Math.ceil(query.data.total / PAGE_SIZE))
  const charts = embedding
    ? ['req_latency', 'req_tokens', 'req_success']
    : ['req_latency', 'req_ttft_tpot', 'req_tokens', 'req_success']
  const fallback = { columns: query.data.columns, rows: query.data.rows }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'success', 'failed'] as const).map((value) => (
          <Button
            aria-pressed={status === value}
            key={value}
            onClick={() => onStatusChange(value)}
            size="sm"
            variant={status === value ? 'default' : 'outline'}
          >
            {t(`evaluations.performance.status_${value}`)}
          </Button>
        ))}
        <span className="ml-auto font-mono text-muted-foreground text-xs">
          {query.data.total} {t('evaluations.performance.requests')}
        </span>
      </div>
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.performance.requests')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          {query.data.rows.length ? (
            <TableContainer aria-label={t('evaluations.performance.requests')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    {query.data.columns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.rows.map((row) => (
                    <TableRow key={String(row.id ?? row.request_id ?? JSON.stringify(row))}>
                      {query.data?.columns.map((column) => (
                        <TableCell className="max-w-72 break-words font-mono text-xs" key={column}>
                          {typeof row[column] === 'object'
                            ? JSON.stringify(row[column])
                            : String(row[column] ?? '—')}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('evaluations.performance.noRequests')}
            </p>
          )}
        </SurfaceBody>
      </Surface>
      <div className="flex items-center justify-end gap-2">
        <Button
          aria-label={t('evaluations.prediction.previousSample')}
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          size="sm"
          variant="outline"
        >
          <ChevronLeft aria-hidden="true" size={14} />
        </Button>
        <span className="font-mono text-sm">
          {page} / {totalPages}
        </span>
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
      <div className="grid gap-4 xl:grid-cols-2">
        {charts.map((chart) => (
          <GeneratedChartPanel
            fallback={fallback}
            key={chart}
            load={(signal) =>
              evalScopeClient.request('perfChart', {
                query: { chart_type: chart, path, run, theme: 'dark' },
                signal,
              })
            }
            queryKey={['evalscope', 'performance', path, run, chart]}
            title={t(`evaluations.performance.chart_${chart}`, { defaultValue: chart })}
          />
        ))}
      </div>
    </div>
  )
}
