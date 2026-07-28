import { AlertTriangle, Info } from 'lucide-react'
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
import type { PerformanceCompareModel } from '../../domain/performance/compare.js'

export function ComparisonCompatibility({
  missing,
  model,
}: {
  readonly missing: number
  readonly model: PerformanceCompareModel
}) {
  const { t } = useTranslation()
  const hasIncomputable = model.deltas.some((delta) => delta.verdict === 'incomputable')
  return (
    <div className="space-y-3">
      {model.workloadMismatch ? (
        <div
          className="flex items-start gap-2 rounded-[5px] border border-warning/35 bg-warning/7 px-4 py-3 text-sm"
          role="status"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-warning" size={15} />
          {t('evaluations.performance.workloadMismatch')}
        </div>
      ) : null}
      {missing > 0 || hasIncomputable ? (
        <div
          className="flex items-start gap-2 rounded-[5px] border border-warning/35 bg-warning/7 px-4 py-3 text-sm"
          role="status"
        >
          <Info aria-hidden="true" className="mt-0.5 shrink-0 text-warning" size={15} />
          {t('evaluations.performance.missingPerfData')}
        </div>
      ) : null}
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.performance.configDiffTitle')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          {model.configDiff.length ? (
            <TableContainer aria-label={t('evaluations.performance.configDiffTitle')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('evaluations.performance.configKeyCol')}</TableHead>
                    <TableHead>{t('evaluations.performance.baselineCol')}</TableHead>
                    <TableHead>{t('evaluations.performance.candidateCol')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.configDiff.map((entry) => (
                    <TableRow key={entry.key}>
                      <TableCell>{entry.key}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.baseline || '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.candidate || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('evaluations.performance.noConfigDiff')}
            </p>
          )}
        </SurfaceBody>
      </Surface>
    </div>
  )
}
