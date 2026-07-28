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
import type { PerfRunSummary } from '../../api/schemas.js'
import { formatMetricValue } from '../../domain/metric.js'
import { resolvePerformanceProvider } from '../../domain/performance/provider.js'

function SelectRun({
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
      type="checkbox"
    />
  )
}

export function PerformanceCatalogue({
  allSelected,
  onSelectAll,
  onToggle,
  runs,
  selected,
}: {
  readonly allSelected: boolean
  readonly onSelectAll: () => void
  readonly onToggle: (path: string) => void
  readonly runs: readonly PerfRunSummary[]
  readonly selected: readonly string[]
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="hidden lg:block">
        <TableContainer aria-label={t('evaluations.nav.performance')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <SelectRun
                    checked={allSelected}
                    label={t('evaluations.reports.selectAll')}
                    onChange={onSelectAll}
                  />
                </TableHead>
                <TableHead>{t('evaluations.dashboard.model')}</TableHead>
                <TableHead>{t('evaluations.dashboard.dataset')}</TableHead>
                <TableHead>{t('evaluations.performance.provider')}</TableHead>
                <TableHead>{t('evaluations.performance.protocol')}</TableHead>
                <TableHead className="text-right">RPS</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead>{t('evaluations.dashboard.date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const identity = resolvePerformanceProvider(run)
                return (
                  <TableRow
                    className={selected.includes(run.path) ? 'bg-primary/6' : undefined}
                    key={run.path}
                  >
                    <TableCell>
                      <SelectRun
                        checked={selected.includes(run.path)}
                        label={`${t('evaluations.reports.selectReport')}: ${run.model}`}
                        onChange={() => onToggle(run.path)}
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        className="font-medium hover:text-primary"
                        params={{ performanceKey: run.path }}
                        to="/evaluations/performance/$performanceKey"
                      >
                        {run.model}
                      </Link>
                    </TableCell>
                    <TableCell>{run.dataset || '—'}</TableCell>
                    <TableCell>{identity.provider}</TableCell>
                    <TableCell>
                      <Badge tone="muted">{identity.protocol}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatMetricValue('rps', run.best_rps).primary}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatMetricValue('latency', run.best_latency).primary}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">
                      {run.timestamp?.replace('T', ' ').slice(0, 16) || '—'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </div>
      <div className="space-y-2 lg:hidden">
        <div className="flex min-h-10 items-center gap-2 text-muted-foreground text-sm">
          <SelectRun
            checked={allSelected}
            label={t('evaluations.reports.selectAll')}
            onChange={onSelectAll}
          />
          {t('evaluations.reports.selectAll')}
        </div>
        {runs.map((run) => {
          const identity = resolvePerformanceProvider(run)
          return (
            <article
              className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[6px] border p-4 ${selected.includes(run.path) ? 'border-primary/60 bg-primary/5' : 'border-border bg-surface/70'}`}
              key={run.path}
            >
              <SelectRun
                checked={selected.includes(run.path)}
                label={run.model}
                onChange={() => onToggle(run.path)}
              />
              <div className="min-w-0">
                <Link
                  className="font-semibold hover:text-primary"
                  params={{ performanceKey: run.path }}
                  to="/evaluations/performance/$performanceKey"
                >
                  {run.model}
                </Link>
                <p className="mt-1 text-muted-foreground text-sm">
                  {run.dataset || '—'} · {identity.provider} · {identity.protocol}
                </p>
                <p className="mt-1 font-mono text-xs">
                  {formatMetricValue('rps', run.best_rps).primary} ·{' '}
                  {formatMetricValue('latency', run.best_latency).primary}
                </p>
              </div>
              <Link
                aria-label={run.model}
                className="inline-flex size-10 items-center justify-center rounded hover:bg-surface-hover"
                params={{ performanceKey: run.path }}
                to="/evaluations/performance/$performanceKey"
              >
                <ChevronRight aria-hidden="true" size={16} />
              </Link>
            </article>
          )
        })}
      </div>
    </>
  )
}
