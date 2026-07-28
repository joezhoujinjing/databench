import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeftRight, GitCompareArrows } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  MetricItem,
  MetricStrip,
  PageHeader,
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
import { evalScopeClient } from '../api/client.js'
import { decodeCompareReports } from '../domain/compare.js'
import {
  buildPerformanceCompareModel,
  classifyPerformanceSampleSize,
  formatPerformanceDelta,
  shouldDeemphasizePercentile,
} from '../domain/performance/compare.js'
import { isEmbeddingPerformance } from '../domain/performance/view.js'
import { decodeReportKey, encodeReportKey } from '../domain/report-key.js'
import { ComparisonCompatibility } from '../features/performance/ComparisonCompatibility.js'
import { LowSampleNotice } from '../features/performance/LowSampleNotice.js'
import { PerformanceCompareCharts } from '../features/performance/PerformanceCompareCharts.js'

const routeApi = getRouteApi('/evaluations/performance/compare')

export function EvaluationPerformanceCompareRoute() {
  const { t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const paths = useMemo(() => decodeCompareReports(search.runs), [search.runs])
  const baseline = useMemo(() => {
    if (!search.baseline) return undefined
    try {
      return decodeReportKey(search.baseline)
    } catch {
      return undefined
    }
  }, [search.baseline])
  const query = useQuery({
    enabled: paths.length >= 2,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        paths.map((path) => evalScopeClient.request('perfDetail', { query: { path }, signal })),
      )
      return {
        details: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        missing: results.filter((result) => result.status === 'rejected').length,
      }
    },
    queryKey: ['evalscope', 'performance', 'compare', paths.join(';')],
    retry: false,
  })
  const model = buildPerformanceCompareModel(query.data?.details ?? [], baseline)
  const embedding = query.data?.details.some(isEmbeddingPerformance) ?? search.embedding === 1
  useEffect(() => {
    if (!model) return
    const encoded = encodeReportKey(model.baselineId)
    if (encoded !== search.baseline || Number(embedding) !== search.embedding)
      void navigate({
        replace: true,
        search: (current) => ({
          ...current,
          baseline: encoded,
          embedding: Number(embedding) as 0 | 1,
        }),
      })
  }, [embedding, model, navigate, search.baseline, search.embedding])
  if (paths.length < 2)
    return (
      <Alert role="status">
        {t('evaluations.performance.selectToCompare')}{' '}
        <Link className="text-primary hover:underline" to="/evaluations/performance">
          {t('evaluations.nav.performance')}
        </Link>
      </Alert>
    )
  if (query.isLoading)
    return <p className="text-muted-foreground text-sm">{t('evaluations.common.loading')}</p>
  if (query.error || !model)
    return (
      <Alert role="alert">
        {query.error instanceof Error
          ? query.error.message
          : t('evaluations.performance.compareLoadError')}
      </Alert>
    )
  const baselineDetail = query.data?.details.find((detail) => detail.path === model.baselineId)
  const candidateDetail = query.data?.details.find((detail) => detail.path === model.candidateId)
  const counts = [
    model.sampleCounts[model.baselineId] ?? 0,
    model.sampleCounts[model.candidateId] ?? 0,
  ]
  const sampleTier = counts.some((count) => classifyPerformanceSampleSize(count) === 'critical')
    ? 'critical'
    : counts.some((count) => classifyPerformanceSampleSize(count) === 'warning')
      ? 'warning'
      : 'normal'
  return (
    <div className="space-y-5">
      <PageHeader
        description={t('evaluations.performance.compareDescription')}
        eyebrow={
          <Link className="hover:text-primary" to="/evaluations/performance">
            {t('evaluations.nav.performance')}
          </Link>
        }
        title={t('evaluations.performance.comparePageTitle')}
      />
      <Surface>
        <SurfaceBody className="grid items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
          <div>
            <Badge tone="muted">{t('evaluations.performance.baselineBadge')}</Badge>
            <h2 className="mt-2 font-semibold">{baselineDetail?.model}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {baselineDetail?.dataset} ·{' '}
              {baselineDetail?.generated_at.replace('T', ' ').slice(0, 16)}
            </p>
          </div>
          <Button
            aria-label={t('evaluations.performance.swapBaseline')}
            onClick={() =>
              void navigate({
                replace: true,
                search: (current) => ({ ...current, baseline: encodeReportKey(model.candidateId) }),
              })
            }
            size="sm"
            variant="outline"
          >
            <ArrowLeftRight aria-hidden="true" size={14} />
            {t('evaluations.performance.swapBaseline')}
          </Button>
          <div className="md:text-right">
            <Badge tone="green">{t('evaluations.performance.candidateBadge')}</Badge>
            <h2 className="mt-2 font-semibold">{candidateDetail?.model}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {candidateDetail?.dataset} ·{' '}
              {candidateDetail?.generated_at.replace('T', ' ').slice(0, 16)}
            </p>
          </div>
        </SurfaceBody>
      </Surface>
      <MetricStrip className="lg:grid-cols-3">
        <MetricItem
          label={t('evaluations.performance.baselineBadge')}
          value={`${counts[0]} ${t('evaluations.dashboard.samples')}`}
        />
        <MetricItem
          label={t('evaluations.performance.candidateBadge')}
          value={`${counts[1]} ${t('evaluations.dashboard.samples')}`}
        />
        <MetricItem
          label={t('evaluations.performance.comparing', { n: paths.length })}
          value={
            <span className="inline-flex items-center gap-2">
              <GitCompareArrows aria-hidden="true" size={15} />
              {model.deltas.length} metrics
            </span>
          }
        />
      </MetricStrip>
      <LowSampleNotice counts={counts} />
      <ComparisonCompatibility missing={query.data?.missing ?? 0} model={model} />
      {(query.data?.details.length ?? 0) <= 2 ? (
        <Alert role="status">{t('evaluations.performance.sparseCompareHint')}</Alert>
      ) : null}
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('evaluations.performance.deltaSummary')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <TableContainer aria-label={t('evaluations.performance.deltaSummary')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('evaluations.performance.metricCol')}</TableHead>
                  <TableHead className="text-right">
                    {t('evaluations.performance.baselineCol')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('evaluations.performance.candidateCol')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('evaluations.performance.absDeltaCol')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('evaluations.performance.pctDeltaCol')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('evaluations.performance.directionCol')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {model.deltas.map((delta) => {
                  const formatted = formatPerformanceDelta(delta)
                  const deemphasized =
                    delta.verdict === 'incomputable' ||
                    shouldDeemphasizePercentile(delta.key, sampleTier)
                  return (
                    <TableRow
                      className={deemphasized ? 'opacity-50' : undefined}
                      data-deemphasized={deemphasized || undefined}
                      key={delta.key}
                    >
                      <TableCell>{delta.key}</TableCell>
                      <TableCell className="text-right font-mono">{formatted.baseline}</TableCell>
                      <TableCell className="text-right font-mono">{formatted.candidate}</TableCell>
                      <TableCell className="text-right font-mono">{formatted.absolute}</TableCell>
                      <TableCell className="text-right font-mono">{formatted.percent}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          tone={
                            delta.verdict === 'improvement'
                              ? 'green'
                              : delta.verdict === 'regression'
                                ? 'orange'
                                : 'muted'
                          }
                        >
                          {t(`evaluations.performance.verdict_${delta.verdict}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <p className="mt-3 text-muted-foreground text-xs">
            {t('evaluations.performance.deltaInfoNote')}
          </p>
        </SurfaceBody>
      </Surface>
      <PerformanceCompareCharts embedding={embedding} model={model} paths={paths} />
    </div>
  )
}
