import { useMemo, useState } from 'react'
import { useV2Refs } from '../api/hooks.js'
import type { RefMetadataV2 } from '../api/types.js'
import { V2DatasetsPageView } from '../features/datasets/DatasetsPageView.js'

export function V2DatasetsPage() {
  const refs = useV2Refs(100)
  const [filter, setFilter] = useState('')
  const allRows = refs.data?.pages.flatMap((page) => page.items) ?? []
  const rows = useMemo(() => filterV2Refs(allRows, filter), [allRows, filter])

  return (
    <V2DatasetsPageView
      error={refs.error}
      filter={filter}
      hasNextPage={refs.hasNextPage}
      isError={refs.isError}
      isFetchingNextPage={refs.isFetchingNextPage}
      isLoading={refs.isLoading}
      onFilterChange={setFilter}
      onLoadMore={() => void refs.fetchNextPage()}
      rows={rows}
    />
  )
}

export function filterV2Refs(rows: readonly RefMetadataV2[], filter: string): RefMetadataV2[] {
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
