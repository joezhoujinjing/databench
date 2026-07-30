import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Database, Plus, RotateCcw, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { PageHeader, PageShell, Surface } from '@/components/ui/surface.js'
import { SegmentedTabs } from '@/components/ui/tabs.js'
import { ellipsizeMiddle, formatInteger } from '@/lib/format.js'
import type { DeletedRefMetadataV2, RefMetadataV2 } from '../../api/types.js'
import { V2MutationError } from '../../components/V2MutationError.js'

export type DatasetListMode = 'active' | 'trash'

export function V2DatasetsPageView({
  canNextPage,
  canPreviousPage,
  currentPage,
  error,
  filter,
  hasMoreData,
  isError,
  isFetchingNextPage,
  isLoading,
  loadedPageCount,
  mode,
  onFilterChange,
  onModeChange,
  onNextPage,
  onPreviousPage,
  onRestore,
  restoreError,
  restoringName,
  rowCount,
  rows,
}: {
  canNextPage: boolean
  canPreviousPage: boolean
  currentPage: number
  error: unknown
  filter: string
  hasMoreData: boolean
  isError: boolean
  isFetchingNextPage: boolean
  isLoading: boolean
  loadedPageCount: number
  mode: DatasetListMode
  onFilterChange(value: string): void
  onModeChange(value: DatasetListMode): void
  onNextPage(): void
  onPreviousPage(): void
  onRestore(row: DeletedRefMetadataV2): void
  restoreError: unknown
  restoringName: string | null
  rowCount: number
  rows: readonly (DeletedRefMetadataV2 | RefMetadataV2)[]
}) {
  const { t } = useTranslation()
  const gridClass =
    mode === 'active'
      ? 'grid-cols-[minmax(12rem,32fr)_minmax(16rem,35fr)_minmax(7rem,14fr)_minmax(12rem,19fr)]'
      : 'grid-cols-[minmax(12rem,26fr)_minmax(16rem,30fr)_minmax(7rem,12fr)_minmax(12rem,20fr)_minmax(8rem,12fr)]'

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

      <SegmentedTabs
        items={[
          { label: t('v2.datasets.activeTab'), value: 'active' },
          { label: t('v2.datasets.trashTab'), value: 'trash' },
        ]}
        onChange={onModeChange}
        value={mode}
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
          {hasMoreData
            ? t('v2.datasets.loadedCount', { count: formatInteger(rowCount) })
            : t('v2.datasets.totalCount', { count: formatInteger(rowCount) })}
        </div>
      </div>

      {restoreError === null ? null : <V2MutationError error={restoreError} />}

      <Surface className="overflow-hidden">
        <div
          className={`grid ${gridClass} gap-5 border-border border-b px-6 py-4 text-[0.95rem] text-muted-foreground max-md:hidden`}
        >
          <span>{t('v2.datasets.ref')}</span>
          <span>{t('v2.datasets.version')}</span>
          <span>{t('v2.datasets.records')}</span>
          <span>{mode === 'active' ? t('v2.datasets.updated') : t('v2.datasets.deletedAt')}</span>
          {mode === 'trash' ? <span>{t('v2.datasets.actions')}</span> : null}
        </div>
        {isLoading ? <Spinner /> : null}
        {isError ? <ErrorState error={error} /> : null}
        {!isLoading && !isError && rows.length === 0 ? (
          <EmptyState>
            {mode === 'active' ? t('v2.datasets.empty') : t('v2.datasets.trashEmpty')}
          </EmptyState>
        ) : null}
        {rows.map((row) =>
          mode === 'active' || !('deleted_at' in row) ? (
            <div
              className={`group relative grid min-h-16 ${gridClass} items-center gap-5 border-border border-b px-6 py-4 last:border-b-0 max-md:grid-cols-1`}
              key={row.name}
            >
              <Link
                aria-label={t('v2.datasets.openDataset', { name: row.name })}
                className="absolute inset-0 z-0 transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset"
                params={{ ref: row.name }}
                to="/datasets/$ref"
              />
              <DatasetIdentityCells
                copiedLabel={t('v2.datasets.copyNameSuccess')}
                copyLabel={t('v2.datasets.copyName')}
                row={row}
              />
              <span className="pointer-events-none relative z-10 text-[0.95rem] text-muted-foreground">
                {row.updated_at}
                {row.message ? <Badge className="ml-2">{row.message}</Badge> : null}
              </span>
            </div>
          ) : (
            <div
              className={`group grid min-h-16 ${gridClass} items-center gap-5 border-border border-b px-6 py-4 last:border-b-0 max-md:grid-cols-1`}
              key={row.name}
            >
              <DatasetIdentityCells
                copiedLabel={t('v2.datasets.copyNameSuccess')}
                copyLabel={t('v2.datasets.copyName')}
                row={row}
                versionLink
              />
              <span className="text-[0.95rem] text-muted-foreground">{row.deleted_at}</span>
              <Button
                disabled={restoringName === row.name}
                onClick={() => onRestore(row)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCcw aria-hidden="true" size={14} />
                {restoringName === row.name ? t('v2.datasets.restoring') : t('v2.datasets.restore')}
              </Button>
            </div>
          ),
        )}
      </Surface>

      {!isLoading && !isError && rowCount > 0 ? (
        <nav
          aria-label={t('v2.datasets.pagination')}
          className="flex items-center justify-end gap-3"
        >
          <Button
            aria-label={t('v2.datasets.previousPage')}
            disabled={!canPreviousPage || isFetchingNextPage}
            onClick={onPreviousPage}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronLeft aria-hidden="true" size={15} />
            {t('v2.datasets.previousPage')}
          </Button>
          <span
            aria-live="polite"
            className="min-w-32 text-center text-muted-foreground text-sm tabular-nums"
          >
            {isFetchingNextPage
              ? t('v2.datasets.loadingMore')
              : hasMoreData
                ? t('v2.datasets.pageStatusMore', {
                    current: currentPage,
                    total: loadedPageCount,
                  })
                : t('v2.datasets.pageStatus', {
                    current: currentPage,
                    total: loadedPageCount,
                  })}
          </span>
          <Button
            aria-label={t('v2.datasets.nextPage')}
            disabled={!canNextPage || isFetchingNextPage}
            onClick={onNextPage}
            size="sm"
            type="button"
            variant="outline"
          >
            {t('v2.datasets.nextPage')}
            <ChevronRight aria-hidden="true" size={15} />
          </Button>
        </nav>
      ) : null}
    </PageShell>
  )
}

function DatasetIdentityCells({
  copiedLabel,
  copyLabel,
  row,
  versionLink = false,
}: {
  copiedLabel: string
  copyLabel: string
  row: DeletedRefMetadataV2 | RefMetadataV2
  versionLink?: boolean
}) {
  const version = (
    <span
      className={`relative z-10 min-w-0 font-mono text-dim-foreground text-sm ${versionLink ? '' : 'pointer-events-none'}`}
      title={row.version}
    >
      {ellipsizeMiddle(row.version, 16)}
    </span>
  )
  return (
    <>
      <span className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3 font-medium text-base">
        <Database aria-hidden="true" className="text-primary" size={16} />
        <span className="min-w-0 truncate" title={row.name}>
          {row.name}
        </span>
        <CopyTextButton
          className="pointer-events-auto -mr-1"
          copiedLabel={copiedLabel}
          label={copyLabel}
          text={row.name}
        />
      </span>
      {versionLink ? (
        <Link params={{ ref: row.version }} to="/datasets/$ref">
          {version}
        </Link>
      ) : (
        version
      )}
      <span className="text-base tabular-nums">{formatInteger(row.num_records)}</span>
    </>
  )
}
