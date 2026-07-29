import { useQuery } from '@tanstack/react-query'
import { BarChart3 } from 'lucide-react'
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
import type { GeneratedDocumentDescriptor } from '../../api/schemas.js'
import { SafeGeneratedDocumentFrame } from '../SafeGeneratedDocumentFrame.js'

export type ChartFallback = {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly unknown[] | Readonly<Record<string, unknown>>)[]
}

function FallbackTable({
  fallback,
  title,
}: {
  readonly fallback: ChartFallback
  readonly title: string
}) {
  return (
    <TableContainer aria-label={title}>
      <Table>
        <TableHeader>
          <TableRow>
            {fallback.columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {fallback.rows.map((row) => (
            <TableRow key={JSON.stringify(row)}>
              {fallback.columns.map((column, columnIndex) => (
                <TableCell className="max-w-72 break-words font-mono text-xs" key={column}>
                  {String(chartCell(row, column, columnIndex))}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

function chartCell(
  row: readonly unknown[] | Readonly<Record<string, unknown>>,
  column: string,
  columnIndex: number,
): unknown {
  if (Array.isArray(row)) return row[columnIndex] ?? '—'
  return (row as Readonly<Record<string, unknown>>)[column] ?? '—'
}

export function GeneratedChartPanel({
  fallback,
  load,
  queryKey,
  title,
}: {
  readonly fallback: ChartFallback
  readonly load: (signal: AbortSignal) => Promise<GeneratedDocumentDescriptor>
  readonly queryKey: readonly unknown[]
  readonly title: string
}) {
  const { t } = useTranslation()
  const query = useQuery({ queryFn: ({ signal }) => load(signal), queryKey, retry: false })
  return (
    <Surface>
      <SurfaceHeader className="flex items-center gap-2">
        <BarChart3 aria-hidden="true" className="text-primary" size={15} />
        <SurfaceTitle>{title}</SurfaceTitle>
      </SurfaceHeader>
      <SurfaceBody>
        {query.isLoading ? (
          <Skeleton className="h-72" />
        ) : query.data ? (
          <>
            <SafeGeneratedDocumentFrame
              className="min-h-80 w-full rounded-[5px] border border-border bg-white"
              document={query.data}
              title={title}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-muted-foreground text-xs">
                {t('evaluations.charts.tableFallback')}
              </summary>
              <div className="mt-3">
                <FallbackTable
                  fallback={fallback}
                  title={`${title} ${t('evaluations.charts.tableFallback')}`}
                />
              </div>
            </details>
          </>
        ) : (
          <div className="space-y-3">
            <Alert className="border-warning/35" role="status">
              {query.error instanceof Error
                ? query.error.message
                : t('evaluations.charts.loadError')}
            </Alert>
            <FallbackTable fallback={fallback} title={title} />
          </div>
        )}
      </SurfaceBody>
    </Surface>
  )
}
