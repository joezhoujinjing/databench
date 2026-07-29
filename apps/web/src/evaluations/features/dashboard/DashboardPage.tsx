import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Clock3, Cpu, FileText, Gauge, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { MetricStrip, PageHeader } from '@/components/ui/surface.js'
import { evalScopeClient } from '../../api/client.js'
import type { PerfRunSummary, ReportSummary } from '../../api/schemas.js'
import { ConfiguredSourceRefresh } from '../../components/ConfiguredSourceRefresh.js'
import { useEvaluationService } from '../../components/EvaluationCapabilityBoundary.js'
import {
  DASHBOARD_PAGE_SIZE,
  filterDashboardRuns,
  mergeDashboardRuns,
  summarizeDashboard,
} from '../../domain/dashboard.js'
import { DashboardEmptyState, DashboardPartialState } from './DashboardState.js'
import { RecentRuns } from './RecentRuns.js'

const routeApi = getRouteApi('/evaluations/')

type DashboardData = {
  readonly errors: readonly string[]
  readonly performance: readonly PerfRunSummary[]
  readonly reports: readonly ReportSummary[]
}

async function loadDashboard(signal: AbortSignal, refresh: boolean): Promise<DashboardData> {
  const reportsPromise = (async () => {
    const reports: ReportSummary[] = []
    let page = 1
    let total = Number.POSITIVE_INFINITY
    while (reports.length < total) {
      const response = await evalScopeClient.request('reportsList', {
        query: {
          page,
          page_size: 500,
          refresh: page === 1 && refresh ? true : undefined,
          sort_by: 'time',
          sort_order: 'desc',
        },
        signal,
      })
      reports.push(...response.reports)
      total = response.total
      if (response.reports.length === 0) break
      page += 1
    }
    return reports
  })()
  const performancePromise = evalScopeClient
    .request('perfList', { query: { refresh: refresh || undefined }, signal })
    .then((response) => response.runs)
  const [reports, performance] = await Promise.allSettled([reportsPromise, performancePromise])
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const errors = [reports, performance].flatMap((result) =>
    result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : 'Unknown provider error']
      : [],
  )
  if (reports.status === 'rejected' && performance.status === 'rejected') throw reports.reason
  return {
    errors,
    performance: performance.status === 'fulfilled' ? performance.value : [],
    reports: reports.status === 'fulfilled' ? reports.value : [],
  }
}

function DashboardKpi({
  icon,
  label,
  to,
  value,
}: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly to?: '/evaluations/performance' | '/evaluations/reports'
  readonly value: string
}) {
  const body = (
    <span className="flex min-h-24 min-w-0 items-start justify-between gap-4 px-5 py-4 text-left">
      <span className="min-w-0">
        <span className="block truncate font-semibold text-2xl tabular-nums">{value}</span>
        <span className="mt-2 block text-muted-foreground text-sm">{label}</span>
      </span>
      <span className="mt-1 text-primary">{icon}</span>
    </span>
  )
  return to ? (
    <Link
      className="min-w-0 border-border border-b hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary lg:border-r lg:border-b-0 lg:last:border-r-0"
      to={to}
    >
      {body}
    </Link>
  ) : (
    <div className="min-w-0 border-border border-b lg:border-r lg:border-b-0 lg:last:border-r-0">
      {body}
    </div>
  )
}

export function DashboardPage() {
  const { t } = useTranslation()
  const service = useEvaluationService()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const [searchInput, setSearchInput] = useState(search.search ?? '')
  const [nonce, setNonce] = useState(0)
  const refreshRequested = useRef(false)
  useEffect(() => setSearchInput(search.search ?? ''), [search.search])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = searchInput.trim() || undefined
      if (value !== search.search) {
        void navigate({
          replace: true,
          search: (current) => ({ ...current, page: 1, search: value }),
        })
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [navigate, search.search, searchInput])
  const query = useQuery({
    enabled: service.config.reports_configured,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const refresh = refreshRequested.current
      refreshRequested.current = false
      return loadDashboard(signal, refresh)
    },
    queryKey: ['evalscope', 'dashboard', nonce],
    retry: false,
  })
  const allRuns = useMemo(
    () => mergeDashboardRuns(query.data?.reports ?? [], query.data?.performance ?? []),
    [query.data],
  )
  const filtered = useMemo(
    () => filterDashboardRuns(allRuns, search.type, search.search ?? ''),
    [allRuns, search.search, search.type],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / DASHBOARD_PAGE_SIZE))
  const page = Math.min(search.page, totalPages)
  const visible = filtered.slice((page - 1) * DASHBOARD_PAGE_SIZE, page * DASHBOARD_PAGE_SIZE)
  const kpis = summarizeDashboard(query.data?.reports ?? [], query.data?.performance ?? [])
  const latest = kpis.latest
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        Date.parse(kpis.latest),
      )
    : t('evaluations.dashboard.neverText')
  const refresh = () => {
    setSearchInput('')
    void navigate({ replace: true, search: { page: 1, type: 'all' } }).then(() => {
      refreshRequested.current = true
      setNonce((value) => value + 1)
    })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        actions={
          <ConfiguredSourceRefresh
            configured={service.config.reports_configured}
            isRefreshing={query.isFetching}
            onRefresh={refresh}
          />
        }
        description={t('evaluations.dashboard.description')}
        title={t('evaluations.nav.dashboard')}
      />
      {query.isLoading && !query.data ? (
        <>
          <div className="grid gap-px overflow-hidden rounded-[6px] border border-border bg-border lg:grid-cols-4">
            {['a', 'b', 'c', 'd'].map((key) => (
              <Skeleton className="h-24 rounded-none" key={key} />
            ))}
          </div>
          <Skeleton className="h-80" />
        </>
      ) : query.error && !query.data ? (
        <DashboardPartialState
          errors={[
            query.error instanceof Error ? query.error.message : t('evaluations.common.loadError'),
          ]}
        />
      ) : (
        <>
          <MetricStrip className="lg:grid-cols-4">
            <DashboardKpi
              icon={<FileText aria-hidden="true" size={18} />}
              label={t('evaluations.dashboard.totalEvaluations')}
              to="/evaluations/reports"
              value={String(kpis.evaluations)}
            />
            <DashboardKpi
              icon={<Gauge aria-hidden="true" size={18} />}
              label={t('evaluations.dashboard.totalPerfRuns')}
              to="/evaluations/performance"
              value={String(kpis.performance)}
            />
            <DashboardKpi
              icon={<Cpu aria-hidden="true" size={18} />}
              label={t('evaluations.dashboard.modelsEvaluated')}
              value={String(kpis.models)}
            />
            <DashboardKpi
              icon={<Clock3 aria-hidden="true" size={18} />}
              label={t('evaluations.dashboard.latestRun')}
              value={latest}
            />
          </MetricStrip>
          <DashboardPartialState errors={query.data?.errors ?? []} />
          {allRuns.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <fieldset className="inline-flex rounded-[5px] border border-border bg-background/65 p-1">
                  <legend className="sr-only">{t('evaluations.dashboard.typeFilter')}</legend>
                  {(['all', 'eval', 'perf'] as const).map((type) => (
                    <Button
                      key={type}
                      onClick={() =>
                        void navigate({ search: (current) => ({ ...current, page: 1, type }) })
                      }
                      size="sm"
                      variant={search.type === type ? 'default' : 'ghost'}
                    >
                      {t(`evaluations.dashboard.filter_${type}`)}
                    </Button>
                  ))}
                </fieldset>
                <label
                  className="relative ml-auto w-full sm:w-80"
                  htmlFor="evaluation-dashboard-search"
                >
                  <Search
                    aria-hidden="true"
                    className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                    size={14}
                  />
                  <span className="sr-only">{t('evaluations.dashboard.searchPlaceholder')}</span>
                  <TextInput
                    className="pl-9"
                    id="evaluation-dashboard-search"
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder={t('evaluations.dashboard.searchPlaceholder')}
                    value={searchInput}
                  />
                </label>
              </div>
              {visible.length ? (
                <RecentRuns
                  items={visible}
                  onPageChange={(next) =>
                    void navigate({ search: (current) => ({ ...current, page: next }) })
                  }
                  page={page}
                  totalPages={totalPages}
                  totalResults={filtered.length}
                />
              ) : (
                <DashboardEmptyState filtered />
              )}
            </>
          ) : (
            <DashboardEmptyState filtered={false} />
          )}
        </>
      )}
    </div>
  )
}
