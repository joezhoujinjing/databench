import { useMemo, useState } from 'react'
import { useV2DeletedRefs, useV2Refs, useV2RestoreRef } from '../api/hooks.js'
import type { DeletedRefMetadataV2, RefMetadataV2 } from '../api/types.js'
import { type DatasetListMode, V2DatasetsPageView } from '../features/datasets/DatasetsPageView.js'

export function V2DatasetsPage() {
  const refs = useV2Refs(100)
  const deletedRefs = useV2DeletedRefs(100)
  const restoreRef = useV2RestoreRef()
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<DatasetListMode>('active')
  const query = mode === 'active' ? refs : deletedRefs
  const allRows = query.data?.pages.flatMap((page) => page.items) ?? []
  const rows = useMemo(() => filterV2Refs(allRows, filter), [allRows, filter])

  return (
    <V2DatasetsPageView
      error={query.error}
      filter={filter}
      hasNextPage={query.hasNextPage}
      isError={query.isError}
      isFetchingNextPage={query.isFetchingNextPage}
      isLoading={query.isLoading}
      mode={mode}
      onFilterChange={setFilter}
      onLoadMore={() => void query.fetchNextPage()}
      onModeChange={setMode}
      onRestore={(row) => {
        restoreRef.mutate({
          name: row.name,
          request: { expected_version: row.version },
        })
      }}
      restoreError={restoreRef.error}
      restoringName={restoreRef.isPending ? (restoreRef.variables?.name ?? null) : null}
      rows={rows}
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
