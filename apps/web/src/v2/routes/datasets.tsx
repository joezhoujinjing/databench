import { useMemo, useState } from 'react'
import { useV2DeletedRefs, useV2Refs, useV2RestoreRef } from '../api/hooks.js'
import type { DeletedRefMetadataV2, RefMetadataV2 } from '../api/types.js'
import { type DatasetListMode, V2DatasetsPageView } from '../features/datasets/DatasetsPageView.js'

export const DATASET_PAGE_SIZE = 10

export function V2DatasetsPage() {
  const refs = useV2Refs(100)
  const deletedRefs = useV2DeletedRefs(100)
  const restoreRef = useV2RestoreRef()
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<DatasetListMode>('active')
  const [requestedPageIndex, setRequestedPageIndex] = useState(0)
  const query = mode === 'active' ? refs : deletedRefs
  const allRows = query.data?.pages.flatMap((page) => page.items) ?? []
  const rows = useMemo(() => filterV2Refs(allRows, filter), [allRows, filter])
  const loadedPageCount = datasetPageCount(rows.length)
  const pageIndex = clampDatasetPageIndex(requestedPageIndex, rows.length)
  const pageRows = paginateV2Refs(rows, pageIndex)
  const canNextPage = (pageIndex + 1) * DATASET_PAGE_SIZE < rows.length || query.hasNextPage

  async function handleNextPage() {
    const nextPageIndex = pageIndex + 1
    if (nextPageIndex * DATASET_PAGE_SIZE < rows.length) {
      setRequestedPageIndex(nextPageIndex)
      return
    }
    if (!query.hasNextPage || query.isFetchingNextPage) {
      return
    }

    const result = await query.fetchNextPage()
    const expandedRows = filterV2Refs(
      result.data?.pages.flatMap((page) => page.items) ?? [],
      filter,
    )
    if (nextPageIndex * DATASET_PAGE_SIZE < expandedRows.length) {
      setRequestedPageIndex(nextPageIndex)
    }
  }

  return (
    <V2DatasetsPageView
      canNextPage={canNextPage}
      canPreviousPage={pageIndex > 0}
      currentPage={pageIndex + 1}
      error={query.error}
      filter={filter}
      hasMoreData={query.hasNextPage}
      isError={query.isError}
      isFetchingNextPage={query.isFetchingNextPage}
      isLoading={query.isLoading}
      loadedPageCount={loadedPageCount}
      mode={mode}
      onFilterChange={(value) => {
        setFilter(value)
        setRequestedPageIndex(0)
      }}
      onModeChange={(value) => {
        setMode(value)
        setRequestedPageIndex(0)
      }}
      onNextPage={() => void handleNextPage()}
      onPreviousPage={() => setRequestedPageIndex(Math.max(0, pageIndex - 1))}
      onRestore={(row) => {
        restoreRef.mutate({
          name: row.name,
          request: { expected_version: row.version },
        })
      }}
      restoreError={restoreRef.error}
      restoringName={restoreRef.isPending ? (restoreRef.variables?.name ?? null) : null}
      rowCount={rows.length}
      rows={pageRows}
    />
  )
}

export function filterV2Refs<T extends DeletedRefMetadataV2 | RefMetadataV2>(
  rows: readonly T[],
  filter: string,
): T[] {
  const needle = filter.trim().toLocaleLowerCase()
  return rows
    .filter(
      (row) =>
        needle === '' ||
        row.name.toLocaleLowerCase().includes(needle) ||
        row.version.toLocaleLowerCase().includes(needle),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name))
}

export function datasetPageCount(rowCount: number, pageSize = DATASET_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(rowCount / pageSize))
}

export function clampDatasetPageIndex(
  pageIndex: number,
  rowCount: number,
  pageSize = DATASET_PAGE_SIZE,
): number {
  return Math.min(Math.max(0, pageIndex), datasetPageCount(rowCount, pageSize) - 1)
}

export function paginateV2Refs<T>(
  rows: readonly T[],
  pageIndex: number,
  pageSize = DATASET_PAGE_SIZE,
): T[] {
  const start = clampDatasetPageIndex(pageIndex, rows.length, pageSize) * pageSize
  return rows.slice(start, start + pageSize)
}
