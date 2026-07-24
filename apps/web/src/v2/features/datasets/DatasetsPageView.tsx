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
    <PageShell>
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link to="/v2/ingest">
              <Plus aria-hidden="true" size={16} />
              {t('v2.datasets.newDataset')}
            </Link>
          </Button>
        }
        description={t('v2.datasets.description')}
        eyebrow="V2 / refs"
        title={t('v2.datasets.title')}
      />

      <div className="relative max-w-[48rem]">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
          size={18}
        />
        <TextInput
          aria-label={t('v2.datasets.filter')}
          className="h-12 pl-11"
          onChange={(event) => onFilterChange(event.currentTarget.value)}
          placeholder={t('v2.datasets.filter')}
          value={filter}
        />
      </div>

      <Surface className="overflow-hidden">
        <div className="grid grid-cols-[minmax(12rem,1.2fr)_minmax(16rem,1.7fr)_minmax(7rem,0.65fr)_minmax(12rem,1fr)] border-border border-b px-5 py-3 text-muted-foreground text-sm max-md:hidden">
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
            className="grid min-h-20 grid-cols-[minmax(12rem,1.2fr)_minmax(16rem,1.7fr)_minmax(7rem,0.65fr)_minmax(12rem,1fr)] items-center gap-5 border-border border-b px-5 py-4 transition-colors last:border-b-0 hover:bg-surface-hover max-md:grid-cols-1"
            key={row.name}
            params={{ ref: row.name }}
            to="/v2/datasets/$ref"
          >
            <span className="flex items-center gap-3 font-medium">
              <Database aria-hidden="true" className="text-primary" size={16} />
              {row.name}
            </span>
            <span className="min-w-0 font-mono text-dim-foreground text-xs" title={row.version}>
              {ellipsizeMiddle(row.version, 16)}
            </span>
            <span className="tabular-nums text-sm">{formatInteger(row.num_records)}</span>
            <span className="text-muted-foreground text-sm">
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
