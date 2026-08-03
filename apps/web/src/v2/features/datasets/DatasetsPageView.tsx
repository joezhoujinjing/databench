import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Database, Plus, RotateCcw, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { PageHeader, PageShell, Surface } from '@/components/ui/surface.js'
import { SegmentedTabs } from '@/components/ui/tabs.js'
import { ellipsizeMiddle, formatDateTime, formatInteger } from '@/lib/format.js'
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
  totalRowCount,
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
  totalRowCount: number
}) {
  const { t } = useTranslation()
  const panelId = 'dataset-list-panel'
  const columnCount = mode === 'active' ? 4 : 5
  const hasFilter = filter.trim() !== ''

  return (
    <PageShell className="space-y-3">
      <PageHeader
        actions={
          <Button asChild>
            <Link to="/ingest">
              <Plus aria-hidden="true" size={16} />
              {t('v2.datasets.newDataset')}
            </Link>
          </Button>
        }
        className="pb-0 [&_h1]:text-[1.75rem] [&_h1]:leading-tight"
        title={t('v2.datasets.title')}
      />

      <SegmentedTabs
        ariaLabel={t('v2.datasets.title')}
        items={[
          { label: t('v2.datasets.activeTab'), value: 'active' },
          { label: t('v2.datasets.trashTab'), value: 'trash' },
        ]}
        onChange={onModeChange}
        panelId={panelId}
        value={mode}
      />

      <div
        aria-labelledby={`${panelId}-tab-${mode}`}
        className="space-y-3"
        id={panelId}
        role="tabpanel"
      >
        <div className="flex items-center justify-between gap-5">
          <div className="relative w-full max-w-[40rem]">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              size={17}
            />
            <TextInput
              aria-label={t('v2.datasets.filter')}
              className="h-10 py-0 pr-3 pl-10"
              onChange={(event) => onFilterChange(event.currentTarget.value)}
              placeholder={t('v2.datasets.filter')}
              value={filter}
            />
          </div>
          <div className="shrink-0 text-muted-foreground text-sm tabular-nums max-sm:hidden">
            {hasFilter
              ? hasMoreData
                ? t('v2.datasets.filteredLoadedCount', {
                    count: formatInteger(rowCount),
                    total: formatInteger(totalRowCount),
                  })
                : t('v2.datasets.filteredTotalCount', {
                    count: formatInteger(rowCount),
                    total: formatInteger(totalRowCount),
                  })
              : hasMoreData
                ? t('v2.datasets.loadedCount', { count: formatInteger(rowCount) })
                : t('v2.datasets.totalCount', { count: formatInteger(rowCount) })}
          </div>
        </div>

        {restoreError === null ? null : <V2MutationError error={restoreError} />}

        <Surface className="overflow-hidden shadow-none">
          <div className="overflow-x-auto">
            <table
              className={`w-full table-fixed text-left ${mode === 'active' ? 'min-w-[48rem]' : 'min-w-[58rem]'}`}
            >
              <caption className="sr-only">{t('v2.datasets.title')}</caption>
              <DatasetColumnWidths mode={mode} />
              <thead>
                <tr className="h-10 border-border border-b bg-chrome/32 text-muted-foreground text-sm">
                  <th className="px-5 font-normal" scope="col">
                    {t('v2.datasets.ref')}
                  </th>
                  <th className="px-5 font-normal" scope="col">
                    {t('v2.datasets.version')}
                  </th>
                  <th className="px-5 text-right font-normal" scope="col">
                    {t('v2.datasets.records')}
                  </th>
                  <th className="px-5 font-normal" scope="col">
                    {mode === 'active' ? t('v2.datasets.updated') : t('v2.datasets.deletedAt')}
                  </th>
                  {mode === 'trash' ? (
                    <th className="px-5 font-normal" scope="col">
                      {t('v2.datasets.actions')}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <TableStateRow colSpan={columnCount}>
                    <Spinner />
                  </TableStateRow>
                ) : null}
                {isError ? (
                  <TableStateRow colSpan={columnCount}>
                    <ErrorState error={error} />
                  </TableStateRow>
                ) : null}
                {!isLoading && !isError && rows.length === 0 ? (
                  <TableStateRow colSpan={columnCount}>
                    <EmptyState>
                      {hasFilter
                        ? t('v2.datasets.filterEmpty')
                        : mode === 'active'
                          ? t('v2.datasets.empty')
                          : t('v2.datasets.trashEmpty')}
                    </EmptyState>
                  </TableStateRow>
                ) : null}
                {rows.map((row) =>
                  mode === 'active' || !('deleted_at' in row) ? (
                    <tr
                      className="group relative h-[3.25rem] cursor-pointer border-border border-b transition-colors last:border-b-0 hover:bg-surface-hover/45 focus-within:bg-surface-hover/45"
                      key={row.name}
                    >
                      <DatasetIdentityCells
                        copiedLabel={t('v2.datasets.copyNameSuccess')}
                        copyLabel={t('v2.datasets.copyName')}
                        openLabel={t('v2.datasets.openDataset', { name: row.name })}
                        row={row}
                      />
                      <td className="pointer-events-none relative z-10 px-5 py-2 text-muted-foreground text-sm tabular-nums">
                        <time dateTime={row.updated_at} title={row.updated_at}>
                          {formatDateTime(row.updated_at)}
                        </time>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      className="group h-[3.25rem] border-border border-b transition-colors last:border-b-0 hover:bg-surface-hover/45 focus-within:bg-surface-hover/45"
                      key={row.name}
                    >
                      <DatasetIdentityCells
                        copiedLabel={t('v2.datasets.copyNameSuccess')}
                        copyLabel={t('v2.datasets.copyName')}
                        row={row}
                        versionLink
                      />
                      <td className="px-5 py-2 text-muted-foreground text-sm tabular-nums">
                        <time dateTime={row.deleted_at} title={row.deleted_at}>
                          {formatDateTime(row.deleted_at)}
                        </time>
                      </td>
                      <td className="px-5 py-2">
                        <Button
                          disabled={restoringName === row.name}
                          onClick={() => onRestore(row)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <RotateCcw aria-hidden="true" size={14} />
                          {restoringName === row.name
                            ? t('v2.datasets.restoring')
                            : t('v2.datasets.restore')}
                        </Button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {!isLoading && !isError && rowCount > 0 ? (
            <nav
              aria-label={t('v2.datasets.pagination')}
              className="flex min-h-11 items-center justify-end gap-2 border-border border-t bg-chrome/32 px-4"
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
                className="min-w-28 text-center text-muted-foreground text-sm tabular-nums"
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
        </Surface>
      </div>
    </PageShell>
  )
}

function DatasetColumnWidths({ mode }: { mode: DatasetListMode }) {
  return mode === 'active' ? (
    <colgroup>
      <col className="w-[30%]" />
      <col className="w-[34%]" />
      <col className="w-[14%]" />
      <col className="w-[22%]" />
    </colgroup>
  ) : (
    <colgroup>
      <col className="w-[26%]" />
      <col className="w-[30%]" />
      <col className="w-[12%]" />
      <col className="w-[20%]" />
      <col className="w-[12%]" />
    </colgroup>
  )
}

function TableStateRow({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return (
    <tr>
      <td className="p-4" colSpan={colSpan}>
        {children}
      </td>
    </tr>
  )
}

function DatasetIdentityCells({
  copiedLabel,
  copyLabel,
  openLabel,
  row,
  versionLink = false,
}: {
  copiedLabel: string
  copyLabel: string
  openLabel?: string
  row: DeletedRefMetadataV2 | RefMetadataV2
  versionLink?: boolean
}) {
  const version = (
    <span className="min-w-0 font-mono text-dim-foreground text-sm" title={row.version}>
      {ellipsizeMiddle(row.version, 16)}
    </span>
  )
  return (
    <>
      <td className={`px-5 py-2 ${openLabel === undefined ? '' : 'pointer-events-none'}`}>
        {openLabel === undefined ? null : (
          <Link
            aria-label={openLabel}
            className="pointer-events-auto absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset"
            params={{ ref: row.name }}
            to="/datasets/$ref"
          />
        )}
        <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3 font-medium text-base">
          <Database aria-hidden="true" className="shrink-0 text-primary" size={16} />
          <span className="min-w-0 truncate" title={row.name}>
            {row.name}
          </span>
          <CopyTextButton
            className="pointer-events-auto -mr-1 opacity-35 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            copiedLabel={copiedLabel}
            label={copyLabel}
            text={row.name}
          />
        </div>
      </td>
      <td
        className={`relative z-10 px-5 py-2 ${openLabel === undefined ? '' : 'pointer-events-none'}`}
      >
        {versionLink ? (
          <Link className="hover:text-foreground" params={{ ref: row.version }} to="/datasets/$ref">
            {version}
          </Link>
        ) : (
          version
        )}
      </td>
      <td
        className={`relative z-10 px-5 py-2 text-right text-sm tabular-nums ${openLabel === undefined ? '' : 'pointer-events-none'}`}
      >
        {formatInteger(row.num_records)}
      </td>
    </>
  )
}
