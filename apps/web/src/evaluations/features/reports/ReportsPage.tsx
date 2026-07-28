import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { PageHeader } from '@/components/ui/surface.js'
import { evalScopeClient } from '../../api/client.js'
import { ConfiguredSourceRefresh } from '../../components/ConfiguredSourceRefresh.js'
import { useEvaluationService } from '../../components/EvaluationCapabilityBoundary.js'
import {
  decodeFilterList,
  encodeFilterList,
  REPORT_PAGE_SIZE,
  toggleCurrentPageSelection,
  toggleReportSelection,
} from '../../domain/reports.js'
import { ReportFilters, type ReportFilterValues } from './ReportFilters.js'
import { ReportSelectionTray } from './ReportSelectionTray.js'
import { ReportsCatalogue } from './ReportsCatalogue.js'
import { ReportsState } from './ReportsState.js'

const routeApi = getRouteApi('/evaluations/reports')

export function ReportsPage() {
  const { t } = useTranslation()
  const service = useEvaluationService()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const [searchInput, setSearchInput] = useState(search.search ?? '')
  const [selection, setSelection] = useState<string[]>([])
  const [capReached, setCapReached] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
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

  const filters: ReportFilterValues = useMemo(
    () => ({
      datasets: decodeFilterList(search.datasets),
      models: decodeFilterList(search.models),
      scoreMax: search.scoreMax,
      scoreMin: search.scoreMin,
      sortBy: search.sortBy,
      sortOrder: search.sortOrder,
    }),
    [
      search.datasets,
      search.models,
      search.scoreMax,
      search.scoreMin,
      search.sortBy,
      search.sortOrder,
    ],
  )
  const scoreRangeInvalid =
    filters.scoreMin !== undefined &&
    filters.scoreMax !== undefined &&
    filters.scoreMin > filters.scoreMax
  const query = useQuery({
    enabled: service.config.reports_configured && !scoreRangeInvalid,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const refresh = refreshRequested.current
      refreshRequested.current = false
      return evalScopeClient.request('reportsList', {
        query: {
          datasets: encodeFilterList(filters.datasets),
          models: encodeFilterList(filters.models),
          page: search.page,
          page_size: REPORT_PAGE_SIZE,
          refresh: refresh || undefined,
          score_max: filters.scoreMax,
          score_min: filters.scoreMin,
          search: search.search,
          sort_by: filters.sortBy,
          sort_order: filters.sortOrder,
        },
        signal,
      })
    },
    queryKey: [
      'evalscope',
      'reports',
      search.search ?? '',
      filters.models.join(';'),
      filters.datasets.join(';'),
      filters.scoreMin ?? '',
      filters.scoreMax ?? '',
      filters.sortBy,
      filters.sortOrder,
      search.page,
      refreshNonce,
    ],
    retry: false,
  })

  const updateFilters = (next: ReportFilterValues) => {
    void navigate({
      replace: true,
      search: (current) => ({
        ...current,
        datasets: encodeFilterList(next.datasets),
        models: encodeFilterList(next.models),
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
        scoreMax: next.scoreMax,
        scoreMin: next.scoreMin,
        sortBy: next.sortBy,
        sortOrder: next.sortOrder,
      }),
    })
  }
  const clearFilters = () => {
    setSearchInput('')
    void navigate({
      replace: true,
      search: { page: 1, pageSize: REPORT_PAGE_SIZE, sortBy: 'time', sortOrder: 'desc' },
    })
  }
  const refresh = () => {
    setSelection([])
    setCapReached(false)
    setSearchInput('')
    void navigate({
      replace: true,
      search: { page: 1, pageSize: REPORT_PAGE_SIZE, sortBy: 'time', sortOrder: 'desc' },
    }).then(() => {
      refreshRequested.current = true
      setRefreshNonce((value) => value + 1)
    })
  }
  const reports = query.data?.reports ?? []
  const currentPageNames = reports.map((report) => report.name)
  const allSelected =
    currentPageNames.length > 0 && currentPageNames.every((name) => selection.includes(name))
  const toggle = (name: string) => {
    const result = toggleReportSelection(selection, name)
    setSelection(result.next)
    setCapReached(result.rejected)
  }
  const toggleAll = () => {
    const result = toggleCurrentPageSelection(selection, currentPageNames)
    setSelection(result.next)
    setCapReached(result.rejected)
  }
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / REPORT_PAGE_SIZE))
  const hasFilters = Boolean(
    search.search ||
      filters.models.length ||
      filters.datasets.length ||
      filters.scoreMin !== undefined ||
      filters.scoreMax !== undefined,
  )
  const error = scoreRangeInvalid
    ? t('evaluations.reports.scoreRangeInvalid')
    : query.error instanceof Error
      ? query.error.message
      : undefined

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
        description={t('evaluations.reports.description')}
        title={t('evaluations.reports.title')}
      />
      {!service.config.reports_configured ? (
        <Alert className="border-warning/35" role="alert">
          {t('evaluations.reports.sourceUnavailableDescription')}
        </Alert>
      ) : (
        <>
          <ReportFilters
            availableDatasets={query.data?.filters.available_datasets ?? []}
            availableModels={query.data?.filters.available_models ?? []}
            onChange={updateFilters}
            onSearchChange={setSearchInput}
            search={searchInput}
            values={filters}
          />
          {query.error && query.data ? (
            <Alert className="border-warning/35" role="alert">
              {query.error instanceof Error
                ? query.error.message
                : t('evaluations.common.loadError')}
            </Alert>
          ) : null}
          {query.isLoading && query.data === undefined ? (
            <div className="space-y-2">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                <Skeleton className="h-16" key={key} />
              ))}
            </div>
          ) : reports.length > 0 ? (
            <ReportsCatalogue
              allSelected={allSelected}
              onSelectAll={toggleAll}
              onToggle={toggle}
              reports={reports}
              selected={selection}
            />
          ) : (
            <ReportsState
              error={error}
              hasFilters={hasFilters}
              onClear={clearFilters}
              onRetry={() => void query.refetch()}
            />
          )}
          <div className="flex items-center justify-between border-border border-t pt-4">
            <span className="font-mono text-muted-foreground text-xs">
              {query.data?.total ?? 0} reports · generation{' '}
              {query.data?.report_root_generation ?? service.config.report_root_generation}
            </span>
            <div className="flex items-center gap-2">
              <Button
                aria-label={t('evaluations.prediction.previousSample')}
                disabled={search.page <= 1}
                onClick={() =>
                  void navigate({
                    search: (current) => ({ ...current, page: Math.max(1, current.page - 1) }),
                  })
                }
                size="sm"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" size={14} />
              </Button>
              <span className="font-mono text-sm">
                {search.page} / {totalPages}
              </span>
              <Button
                aria-label={t('evaluations.prediction.nextSample')}
                disabled={search.page >= totalPages}
                onClick={() =>
                  void navigate({
                    search: (current) => ({
                      ...current,
                      page: Math.min(totalPages, current.page + 1),
                    }),
                  })
                }
                size="sm"
                variant="outline"
              >
                <ChevronRight aria-hidden="true" size={14} />
              </Button>
            </div>
          </div>
          <ReportSelectionTray
            capReached={capReached}
            onClear={() => {
              setSelection([])
              setCapReached(false)
            }}
            selected={selection}
          />
        </>
      )}
    </div>
  )
}
