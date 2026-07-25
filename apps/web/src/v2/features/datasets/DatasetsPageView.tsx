import { Link } from '@tanstack/react-router'
import { Database, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { PageHeader, PageShell, Surface } from '@/components/ui/surface.js'
import { ellipsizeMiddle, formatInteger } from '@/lib/format.js'
import type { RefMetadataV2 } from '../../api/types.js'

export function V2DatasetsPageView({
  error,
  filter,
  hasNextPage,
  isError,
  isFetchingNextPage,
  isLoading,
  onFilterChange,
  onLoadMore,
  rows,
}: {
  error: unknown
  filter: string
  hasNextPage: boolean
  isError: boolean
  isFetchingNextPage: boolean
  isLoading: boolean
  onFilterChange(value: string): void
  onLoadMore(): void
  rows: readonly RefMetadataV2[]
}) {
  const { t } = useTranslation()

  return (
    <PageShell className="space-y-6">
      <PageHeader
        actions={
          <Button asChild className="h-14 px-7 text-base" variant="outline">
            <Link to="/ingest">
              <Plus aria-hidden="true" size={16} />
              {t('v2.datasets.newDataset')}
            </Link>
          </Button>
        }
        title={t('v2.datasets.title')}
      />

      <div className="flex items-center justify-between gap-5">
        <div className="relative w-full max-w-[52.75rem]">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
            size={18}
          />
          <TextInput
            aria-label={t('v2.datasets.filter')}
            className="h-14 pl-11 text-base"
            onChange={(event) => onFilterChange(event.currentTarget.value)}
            placeholder={t('v2.datasets.filter')}
            value={filter}
          />
        </div>
        <div className="shrink-0 text-base text-muted-foreground tabular-nums max-sm:hidden">
          {hasNextPage
            ? t('v2.datasets.loadedCount', { count: formatInteger(rows.length) })
            : t('v2.datasets.totalCount', { count: formatInteger(rows.length) })}
        </div>
      </div>

      <Surface className="overflow-hidden">
        <div className="grid grid-cols-[minmax(12rem,32fr)_minmax(16rem,35fr)_minmax(7rem,14fr)_minmax(12rem,19fr)] gap-5 border-border border-b px-6 py-4 text-[0.95rem] text-muted-foreground max-md:hidden">
          <span>{t('v2.datasets.ref')}</span>
          <span>{t('v2.datasets.version')}</span>
          <span>{t('v2.datasets.records')}</span>
          <span>{t('v2.datasets.updated')}</span>
        </div>
        {isLoading ? <Spinner /> : null}
        {isError ? <ErrorState error={error} /> : null}
        {!isLoading && !isError && rows.length === 0 ? (
          <EmptyState>{t('v2.datasets.empty')}</EmptyState>
        ) : null}
        {rows.map((row) => (
          <Link
            className="grid min-h-16 grid-cols-[minmax(12rem,32fr)_minmax(16rem,35fr)_minmax(7rem,14fr)_minmax(12rem,19fr)] items-center gap-5 border-border border-b px-6 py-4 transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none max-md:grid-cols-1"
            key={row.name}
            params={{ ref: row.name }}
            to="/datasets/$ref"
          >
            <span className="flex items-center gap-3 font-medium text-base">
              <Database aria-hidden="true" className="text-primary" size={16} />
              {row.name}
            </span>
            <span className="min-w-0 font-mono text-dim-foreground text-sm" title={row.version}>
              {ellipsizeMiddle(row.version, 16)}
            </span>
            <span className="text-base tabular-nums">{formatInteger(row.num_records)}</span>
            <span className="text-[0.95rem] text-muted-foreground">
              {row.updated_at}
              {row.message ? <Badge className="ml-2">{row.message}</Badge> : null}
            </span>
          </Link>
        ))}
      </Surface>

      {hasNextPage ? (
        <Button disabled={isFetchingNextPage} onClick={onLoadMore} type="button" variant="outline">
          {isFetchingNextPage ? t('v2.datasets.loadingMore') : t('v2.datasets.loadMore')}
        </Button>
      ) : null}
    </PageShell>
  )
}
