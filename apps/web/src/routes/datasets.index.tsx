import { useMemo, useState } from 'react'
import { useDatasets, useRefs } from '@/api/hooks.js'
import type { RefInfo } from '@/api/types.js'
import { DatasetsPageView } from '@/features/datasets/DatasetsPageView.js'

export function DatasetsPage() {
  const refs = useRefs(200)
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => filterRefs(refs.data?.items ?? [], filter), [refs.data, filter])
  const rowVersions = useMemo(() => rows.map((row) => row.version), [rows])
  const manifestsByVersion = useDatasets(rowVersions)

  return (
    <DatasetsPageView
      error={refs.error}
      filter={filter}
      isError={refs.isError}
      isLoading={refs.isLoading}
      manifestsByVersion={manifestsByVersion}
      onFilterChange={setFilter}
      rows={rows}
      shouldShowCapped={shouldShowCappedNote(refs.data?.total ?? 0, refs.data?.items.length ?? 0)}
      total={refs.data?.total ?? 0}
      unfilteredCount={refs.data?.items.length ?? 0}
    />
  )
}

export function filterRefs(refs: readonly RefInfo[], filter: string): RefInfo[] {
  const needle = filter.trim().toLowerCase()
  const rows = needle
    ? refs.filter(
        (ref) =>
          ref.name.toLowerCase().includes(needle) || ref.version.toLowerCase().includes(needle),
      )
    : [...refs]

  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

export function shouldShowCappedNote(total: number, shown: number): boolean {
  return total > shown
}
