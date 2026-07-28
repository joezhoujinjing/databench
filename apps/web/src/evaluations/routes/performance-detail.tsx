import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { PageHeader } from '@/components/ui/surface.js'
import { Tabs } from '@/components/ui/tabs.js'
import { evalScopeClient } from '../api/client.js'
import { EvaluationBreadcrumb } from '../components/common/EvaluationBreadcrumb.js'
import { SafeReportLink } from '../components/SafeReportLink.js'
import { resolvePerformanceProvider } from '../domain/performance/provider.js'
import {
  defaultPerformanceDetailTab,
  isEmbeddingPerformance,
  normalizePerformanceDetailTab,
  performanceDetailTabs,
} from '../domain/performance/view.js'
import { PerformanceCharts } from '../features/performance/PerformanceCharts.js'
import { PerformanceOverview } from '../features/performance/PerformanceOverview.js'
import { PerformanceRuns } from '../features/performance/PerformanceRuns.js'

const routeApi = getRouteApi('/evaluations/performance/$performanceKey')

export function EvaluationPerformanceDetailRoute() {
  const { t } = useTranslation()
  const { performanceKey } = routeApi.useParams()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const detail = useQuery({
    queryFn: ({ signal }) =>
      evalScopeClient.request('perfDetail', { query: { path: performanceKey }, signal }),
    queryKey: ['evalscope', 'performance', performanceKey, 'detail'],
    retry: false,
  })
  const document = useQuery({
    enabled: detail.data?.has_html === true,
    queryFn: ({ signal }) =>
      evalScopeClient.request('perfHistoryReport', { query: { path: performanceKey }, signal }),
    queryKey: ['evalscope', 'performance', performanceKey, 'html'],
    retry: false,
  })
  const normalizedTab = detail.data
    ? search.tab === undefined
      ? defaultPerformanceDetailTab(detail.data)
      : normalizePerformanceDetailTab(detail.data, search.tab)
    : (search.tab ?? 'overview')
  useEffect(() => {
    if (detail.data && normalizedTab !== search.tab)
      void navigate({ replace: true, search: (current) => ({ ...current, tab: normalizedTab }) })
  }, [detail.data, navigate, normalizedTab, search.tab])
  if (detail.isLoading)
    return <p className="text-muted-foreground text-sm">{t('evaluations.common.loading')}</p>
  if (detail.error || !detail.data)
    return (
      <Alert role="alert">
        {detail.error instanceof Error ? detail.error.message : t('evaluations.common.loadError')}
      </Alert>
    )
  const identity = resolvePerformanceProvider(detail.data)
  const tabs = performanceDetailTabs(detail.data)
  const tabItems = tabs.map((tab) => ({
    label: t(`evaluations.performance.${tab === 'runs' ? 'runsTab' : tab}`),
    panel:
      tab === 'overview' ? (
        <PerformanceOverview detail={detail.data} singleRun={detail.data.num_runs <= 1} />
      ) : tab === 'charts' ? (
        <PerformanceCharts detail={detail.data} />
      ) : (
        <PerformanceRuns
          embedding={isEmbeddingPerformance(detail.data)}
          onPageChange={(page) => void navigate({ search: (current) => ({ ...current, page }) })}
          onRunChange={(run) =>
            void navigate({
              replace: true,
              search: (current) => ({ ...current, page: 1, run, status: 'all' }),
            })
          }
          onStatusChange={(status) =>
            void navigate({ replace: true, search: (current) => ({ ...current, page: 1, status }) })
          }
          page={search.page}
          path={performanceKey}
          run={search.run}
          status={search.status}
        />
      ),
    value: tab,
  }))
  return (
    <div className="space-y-5">
      <EvaluationBreadcrumb
        items={[
          { label: t('evaluations.nav.performance'), to: '/evaluations/performance' },
          { label: detail.data.model },
        ]}
        label={t('evaluations.foundation.breadcrumb')}
      />
      <PageHeader
        actions={
          document.data ? (
            <SafeReportLink document={document.data}>
              {t('evaluations.performance.viewFullHtml')}
            </SafeReportLink>
          ) : undefined
        }
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-2">
              <span>{t('evaluations.performance.provider')}</span>
              <Badge tone="blue">{identity.provider}</Badge>
            </span>
            <span className="inline-flex items-center gap-2">
              <span>{t('evaluations.performance.protocol')}</span>
              <Badge tone="muted">{identity.protocol}</Badge>
            </span>
            <span>
              {detail.data.dataset} · {detail.data.num_runs}{' '}
              {t(
                detail.data.num_runs === 1
                  ? 'evaluations.performance.runSingular'
                  : 'evaluations.performance.runs',
              )}{' '}
              · {detail.data.generated_at.replace('T', ' ').slice(0, 16)}
            </span>
          </span>
        }
        eyebrow={
          <Link className="hover:text-primary" to="/evaluations/performance">
            {t('evaluations.nav.performance')}
          </Link>
        }
        title={detail.data.model || detail.data.dataset || '—'}
      />
      {document.error ? (
        <Alert className="border-warning/35" role="status">
          {document.error instanceof Error
            ? document.error.message
            : t('evaluations.common.loadError')}
        </Alert>
      ) : null}
      <Tabs
        ariaLabel={t('evaluations.nav.performance')}
        items={tabItems}
        onChange={(tab) => void navigate({ search: (current) => ({ ...current, page: 1, tab }) })}
        value={normalizedTab}
      />
    </div>
  )
}
