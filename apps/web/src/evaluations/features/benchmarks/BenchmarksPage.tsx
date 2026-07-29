import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { PageHeader } from '@/components/ui/surface.js'
import { evalScopeClient } from '../../api/client.js'
import {
  benchmarkCategoryCounts,
  type CategorizedBenchmark,
  filterBenchmarks,
  flattenBenchmarks,
} from '../../domain/benchmarks.js'
import { decodeFilterList, encodeFilterList } from '../../domain/reports.js'
import { BenchmarkCards } from './BenchmarkCards.js'
import { BenchmarkDetail } from './BenchmarkDetail.js'
import { BenchmarkFilters } from './BenchmarkFilters.js'
import { BenchmarkState } from './BenchmarkState.js'

const routeApi = getRouteApi('/evaluations/benchmarks')
const PAGE_SIZE = 24
const CATEGORIES = ['all', 'text', 'multimodal', 'agent', 'aigc'] as const
const SKELETON_KEYS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
] as const

export function BenchmarksPage() {
  const { i18n, t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const [searchInput, setSearchInput] = useState(search.search ?? '')
  const [detail, setDetail] = useState<CategorizedBenchmark | null>(null)
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
    queryFn: ({ signal }) =>
      evalScopeClient.request('benchmarks', { query: { all: true }, signal }),
    queryKey: ['evalscope', 'benchmarks', 'all'],
    retry: false,
  })
  const all = useMemo(() => flattenBenchmarks(query.data ?? {}), [query.data])
  const counts = benchmarkCategoryCounts(all)
  const tags = decodeFilterList(search.tags)
  const availableTags = useMemo(
    () => Array.from(new Set(all.flatMap((benchmark) => benchmark.tags))).sort(),
    [all],
  )
  const filtered = useMemo(
    () => filterBenchmarks(all, search.category, search.search ?? '', tags, i18n.language),
    [all, i18n.language, search.category, search.search, tags],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const page = Math.min(search.page, totalPages)
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const clear = () => {
    setSearchInput('')
    void navigate({ replace: true, search: { category: 'all', page: 1 } })
  }
  return (
    <div className="space-y-5">
      <PageHeader
        description={t('evaluations.benchmarks.description')}
        title={t('evaluations.benchmarks.title')}
      />
      <div
        aria-label={t('evaluations.benchmarks.title')}
        className="flex flex-wrap gap-1 border-border border-b pb-3"
        role="toolbar"
      >
        {CATEGORIES.map((category) => (
          <button
            aria-pressed={search.category === category}
            className={`flex min-h-9 items-center gap-2 rounded-[4px] px-3 text-sm ${search.category === category ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            key={category}
            onClick={() =>
              void navigate({ search: (current) => ({ ...current, category, page: 1 }) })
            }
            type="button"
          >
            {t(`evaluations.benchmarks.${category}`)}
            <Badge tone="muted">{counts[category]}</Badge>
          </button>
        ))}
      </div>
      <BenchmarkFilters
        availableTags={availableTags}
        onSearchChange={setSearchInput}
        onTagsChange={(next) =>
          void navigate({
            replace: true,
            search: (current) => ({ ...current, page: 1, tags: encodeFilterList(next) }),
          })
        }
        search={searchInput}
        tags={tags}
      />
      {query.isLoading ? (
        <div
          aria-label={t('evaluations.common.loading')}
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="status"
        >
          {SKELETON_KEYS.map((key) => (
            <Skeleton className="h-64" key={key} />
          ))}
        </div>
      ) : query.error ? (
        <Alert role="alert">
          {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')}
        </Alert>
      ) : visible.length ? (
        <BenchmarkCards benchmarks={visible} onOpen={setDetail} />
      ) : (
        <BenchmarkState onClear={clear} />
      )}
      <div className="flex items-center justify-between border-border border-t pt-4">
        <span className="text-muted-foreground text-sm">
          {t('evaluations.benchmarks.showing', { n: visible.length, total: filtered.length })}
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
      {detail ? <BenchmarkDetail benchmark={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  )
}
