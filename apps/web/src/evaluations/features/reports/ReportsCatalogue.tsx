import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import type { ReportSummary } from '../../api/schemas.js'
import { boundedMetricRatio, formatMetricValue } from '../../domain/metric.js'

function Score({ metric, value }: { readonly metric: string; readonly value: number }) {
  const ratio = boundedMetricRatio(metric, value)
  return (
    <span
      className={`inline-flex rounded-[4px] border px-2 py-1 font-mono text-xs ${ratio === null ? 'border-border text-foreground' : ratio >= 0.7 ? 'border-success/35 bg-success/8 text-success' : ratio >= 0.4 ? 'border-warning/35 bg-warning/8 text-warning' : 'border-danger/35 bg-danger/8 text-danger'}`}
    >
      {formatMetricValue(metric, value).primary}
    </span>
  )
}

function Selection({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean
  readonly label: string
  readonly onChange: () => void
}) {
  return (
    <input
      aria-label={label}
      checked={checked}
      className="size-4 accent-primary"
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      type="checkbox"
    />
  )
}

export function ReportsCatalogue({
  allSelected,
  onSelectAll,
  onToggle,
  reports,
  selected,
}: {
  readonly allSelected: boolean
  readonly onSelectAll: () => void
  readonly onToggle: (name: string) => void
  readonly reports: readonly ReportSummary[]
  readonly selected: readonly string[]
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="hidden lg:block">
        <TableContainer aria-label={t('evaluations.reports.title')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <Selection
                    checked={allSelected}
                    label={t('evaluations.reports.selectAll')}
                    onChange={onSelectAll}
                  />
                </TableHead>
                <TableHead>{t('evaluations.reports.columns.model')}</TableHead>
                <TableHead>{t('evaluations.reports.columns.dataset')}</TableHead>
                <TableHead>{t('evaluations.reports.columns.time')}</TableHead>
                <TableHead className="text-right">
                  {t('evaluations.reports.columns.samples')}
                </TableHead>
                <TableHead className="text-right">
                  {t('evaluations.reports.columns.score')}
                </TableHead>
                <TableHead>{t('evaluations.reports.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow
                  className={selected.includes(report.name) ? 'bg-primary/6' : undefined}
                  key={report.name}
                >
                  <TableCell>
                    <Selection
                      checked={selected.includes(report.name)}
                      label={`${t('evaluations.reports.selectReport')}: ${report.model_name}`}
                      onChange={() => onToggle(report.name)}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      className="font-medium text-foreground hover:text-primary"
                      params={{ reportKey: report.name }}
                      to="/evaluations/reports/$reportKey"
                    >
                      {report.model_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{report.dataset_name}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-muted-foreground text-xs">
                    {report.timestamp ? report.timestamp.replace('T', ' ').slice(0, 16) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {report.num_samples.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Score metric={report.metric_name ?? 'score'} value={report.score} />
                  </TableCell>
                  <TableCell>
                    <Badge tone="green">{t('evaluations.reports.status.completed')}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </div>
      <div className="space-y-2 lg:hidden">
        <div className="flex min-h-10 items-center gap-2 text-muted-foreground text-sm">
          <Selection
            checked={allSelected}
            label={t('evaluations.reports.selectAll')}
            onChange={onSelectAll}
          />
          {t('evaluations.reports.selectAll')}
        </div>
        {reports.map((report) => (
          <article
            className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[6px] border p-4 ${selected.includes(report.name) ? 'border-primary/60 bg-primary/5' : 'border-border bg-surface/70'}`}
            key={report.name}
          >
            <Selection
              checked={selected.includes(report.name)}
              label={`${t('evaluations.reports.selectReport')}: ${report.model_name}`}
              onChange={() => onToggle(report.name)}
            />
            <div className="min-w-0">
              <Link
                className="font-semibold hover:text-primary"
                params={{ reportKey: report.name }}
                to="/evaluations/reports/$reportKey"
              >
                {report.model_name}
              </Link>
              <p className="mt-1 text-muted-foreground text-sm">
                {report.dataset_name} · {report.num_samples} {t('evaluations.reports.samples')}
              </p>
              <p className="mt-1 font-mono text-muted-foreground text-xs">
                {report.timestamp?.replace('T', ' ').slice(0, 16)}
              </p>
            </div>
            <Link
              aria-label={report.model_name}
              className="inline-flex size-10 items-center justify-center rounded hover:bg-surface-hover"
              params={{ reportKey: report.name }}
              to="/evaluations/reports/$reportKey"
            >
              <ChevronRight aria-hidden="true" size={16} />
            </Link>
            <div className="col-start-2">
              <Score metric={report.metric_name ?? 'score'} value={report.score} />
            </div>
          </article>
        ))}
      </div>
    </>
  )
}
