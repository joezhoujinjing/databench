import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { PageHeader } from '@/components/ui/surface.js'
import { evalScopeClient } from '../../api/client.js'
import { ConfiguredSourceRefresh } from '../../components/ConfiguredSourceRefresh.js'
import { useEvaluationService } from '../../components/EvaluationCapabilityBoundary.js'
import { resolvePerformanceProvider } from '../../domain/performance/provider.js'
import { PerformanceCatalogue } from './PerformanceCatalogue.js'
import { PerformanceCatalogueState } from './PerformanceCatalogueState.js'
import { PerformanceSelection } from './PerformanceSelection.js'

const routeApi = getRouteApi('/evaluations/performance')
const PAGE_SIZE = 20

export function PerformancePage() {
  const { t } = useTranslation()
  const service = useEvaluationService()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const [searchInput, setSearchInput] = useState(search.search ?? '')
  const [selection, setSelection] = useState<string[]>([])
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshRequested = useRef(false)
  useEffect(() => setSearchInput(search.search ?? ''), [search.search])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = searchInput.trim() || undefined
      if (value !== search.search)
        void navigate({
          replace: true,
          search: (current) => ({ ...current, page: 1, search: value }),
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [navigate, search.search, searchInput])
  const query = useQuery({
    enabled: service.config.reports_configured,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const refresh = refreshRequested.current
      refreshRequested.current = false
      return evalScopeClient.request('perfList', {
        query: { refresh: refresh || undefined },
        signal,
      })
    },
    queryKey: ['evalscope', 'performance', refreshNonce],
    retry: false,
  })
  const filtered = useMemo(() => {
    const queryText = (search.search ?? '').toLocaleLowerCase()
    const runs = (query.data?.runs ?? []).filter((run) => {
      if (!queryText) return true
      const identity = resolvePerformanceProvider(run)
      return [run.model, run.dataset, run.api_type, identity.provider, identity.protocol].some(
        (value) => value.toLocaleLowerCase().includes(queryText),
      )
    })
    const direction = search.sortOrder === 'asc' ? 1 : -1
    return runs.sort((left, right) => {
      const value =
        search.sortBy === 'time'
          ? left.timestamp.localeCompare(right.timestamp)
          : search.sortBy === 'rps'
            ? left.best_rps - right.best_rps
            : left.best_latency - right.best_latency
      return value * direction
    })
  }, [query.data, search.search, search.sortBy, search.sortOrder])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const page = Math.min(search.page, totalPages)
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const allSelected = visible.length > 0 && visible.every((run) => selection.includes(run.path))
  const toggle = (path: string) =>
    setSelection((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : current.length >= 5
          ? current
          : [...current, path],
    )
  const toggleAll = () =>
    setSelection((current) =>
      allSelected
        ? current.filter((path) => !visible.some((run) => run.path === path))
        : [
            ...current,
            ...visible.map((run) => run.path).filter((path) => !current.includes(path)),
          ].slice(0, 5),
    )
  const clear = () => {
    setSearchInput('')
    void navigate({ replace: true, search: { page: 1, sortBy: 'time', sortOrder: 'desc' } })
  }
  const refresh = () => {
    setSelection([])
    setSearchInput('')
    void navigate({ replace: true, search: { page: 1, sortBy: 'time', sortOrder: 'desc' } }).then(
      () => {
        refreshRequested.current = true
        setRefreshNonce((value) => value + 1)
      },
    )
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
        description={t('evaluations.performance.description')}
        title={t('evaluations.nav.performance')}
      />
      <div className="grid gap-3 border-border border-y py-4 lg:grid-cols-[1fr_12rem_10rem]">
        <label className="relative" htmlFor="evaluation-performance-search">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <span className="sr-only">{t('evaluations.performance.searchPlaceholder')}</span>
          <TextInput
            className="pl-9"
            id="evaluation-performance-search"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('evaluations.performance.searchPlaceholder')}
            value={searchInput}
          />
        </label>
        <SelectInput
          aria-label={t('evaluations.reports.sortBy')}
          onValueChange={(sortBy) =>
            void navigate({ search: (current) => ({ ...current, page: 1, sortBy }) })
          }
          options={(['time', 'rps', 'latency'] as const).map((value) => ({
            label: t(`evaluations.performance.sort_${value}`),
            value,
          }))}
          value={search.sortBy}
        />
        <SelectInput
          aria-label={t('evaluations.reports.sortOrder')}
          onValueChange={(sortOrder) =>
            void navigate({ search: (current) => ({ ...current, page: 1, sortOrder }) })
          }
          options={[
            { label: t('evaluations.reports.descending'), value: 'desc' as const },
            { label: t('evaluations.reports.ascending'), value: 'asc' as const },
          ]}
          value={search.sortOrder}
        />
      </div>
      {query.error && query.data ? (
        <Alert className="border-warning/35" role="status">
          {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')} ·{' '}
          {t('evaluations.performance.staleDataKept')}
        </Alert>
      ) : null}
      {query.isLoading && !query.data ? (
        <div className="space-y-2">
          {['a', 'b', 'c', 'd', 'e'].map((key) => (
            <Skeleton className="h-16" key={key} />
          ))}
        </div>
      ) : visible.length ? (
        <PerformanceCatalogue
          allSelected={allSelected}
          onSelectAll={toggleAll}
          onToggle={toggle}
          runs={visible}
          selected={selection}
        />
      ) : (
        <PerformanceCatalogueState
          error={
            query.error && !query.data
              ? query.error instanceof Error
                ? query.error.message
                : t('evaluations.common.loadError')
              : undefined
          }
          filtered={Boolean(search.search)}
          onClear={clear}
          onRetry={() => void query.refetch()}
        />
      )}
      <div className="flex items-center justify-between border-border border-t pt-4">
        <span className="font-mono text-muted-foreground text-xs">
          {filtered.length} runs · generation{' '}
          {query.data?.report_root_generation ?? service.config.report_root_generation}
        </span>
        <div className="flex items-center gap-2">
          <Button
            aria-label={t('evaluations.prediction.previousSample')}
            disabled={page <= 1}
            onClick={() =>
              void navigate({ search: (current) => ({ ...current, page: Math.max(1, page - 1) }) })
            }
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
            onClick={() =>
              void navigate({
                search: (current) => ({ ...current, page: Math.min(totalPages, page + 1) }),
              })
            }
            size="sm"
            variant="outline"
          >
            <ChevronRight aria-hidden="true" size={14} />
          </Button>
        </div>
      </div>
      <PerformanceSelection
        onClear={() => setSelection([])}
        runs={query.data?.runs ?? []}
        selected={selection}
      />
    </div>
  )
}
