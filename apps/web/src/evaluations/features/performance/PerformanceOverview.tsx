import { Lightbulb } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import type { PerfDetailResponse } from '../../api/schemas.js'
import { formatPerformanceTableCell } from '../../domain/performance/view.js'

function KeyValues({ values }: { readonly values: Readonly<Record<string, string>> }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {Object.entries(values).map(([key, value]) => (
        <div className="grid grid-cols-[minmax(7rem,0.8fr)_1fr] gap-3 text-sm" key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="break-words font-mono">
            {value ? formatPerformanceTableCell(key, value) : '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function PerformanceOverview({
  detail,
  singleRun,
}: {
  readonly detail: PerfDetailResponse
  readonly singleRun: boolean
}) {
  const { t } = useTranslation()
  const basicInfo = Object.fromEntries(
    Object.entries(detail.basic_info).filter(
      ([key]) => !['API Host', 'API URL', 'Protocol', 'Provider'].includes(key),
    ),
  )
  const summaryTitle = t(
    singleRun ? 'evaluations.performance.runSummary' : 'evaluations.performance.summaryTable',
  )
  return (
    <div className="space-y-4">
      {singleRun ? (
        <p className="rounded-[5px] border border-border bg-surface-soft px-4 py-3 text-muted-foreground text-sm">
          {t('evaluations.performance.singleRunHint')}
        </p>
      ) : null}
      <Surface>
        <SurfaceBody>
          <KeyValues values={basicInfo} />
        </SurfaceBody>
      </Surface>
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{summaryTitle}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <TableContainer aria-label={summaryTitle}>
            <Table>
              <TableHeader>
                <TableRow>
                  {detail.summary_columns.map((column) => (
                    <TableHead key={column}>{column}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.summary_rows.map((row) => (
                  <TableRow key={JSON.stringify(row)}>
                    {detail.summary_columns.map((column, columnIndex) => (
                      <TableCell className="font-mono text-xs" key={column}>
                        {row[columnIndex] === undefined || row[columnIndex] === null
                          ? '—'
                          : formatPerformanceTableCell(column, row[columnIndex])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </SurfaceBody>
      </Surface>
      {Object.keys(detail.best_config).length || detail.recommendations.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Object.keys(detail.best_config).length ? (
            <Surface>
              <SurfaceHeader>
                <SurfaceTitle>
                  {t(
                    singleRun
                      ? 'evaluations.performance.runConfig'
                      : 'evaluations.performance.bestConfig',
                  )}
                </SurfaceTitle>
              </SurfaceHeader>
              <SurfaceBody>
                <KeyValues values={detail.best_config} />
              </SurfaceBody>
            </Surface>
          ) : null}
          {detail.recommendations.length ? (
            <Surface>
              <SurfaceHeader className="flex items-center gap-2">
                <Lightbulb aria-hidden="true" className="text-warning" size={15} />
                <SurfaceTitle>{t('evaluations.performance.recommendations')}</SurfaceTitle>
              </SurfaceHeader>
              <SurfaceBody>
                <ul className="space-y-2 text-sm leading-6">
                  {detail.recommendations.map((recommendation) => (
                    <li className="border-border border-b pb-2 last:border-0" key={recommendation}>
                      {recommendation}
                    </li>
                  ))}
                </ul>
              </SurfaceBody>
            </Surface>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
