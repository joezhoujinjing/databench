import { useVirtualizer } from '@tanstack/react-virtual'
import { type KeyboardEvent, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, Spinner } from '@/components/common/State.js'
import { useV2Records } from '../../api/hooks.js'
import type { RecordSummaryV2 } from '../../api/types.js'
import { V2ReadErrorState } from '../V2ReadErrorState.js'
import { RecordSummaryRow } from './RecordSummaryRow.js'

const RECORD_ROW_ESTIMATE = 80

export function VirtualizedRecords({
  datasetVersion,
  pageSize = 100,
}: {
  datasetVersion: string
  pageSize?: number
}) {
  const { t } = useTranslation()
  const query = useV2Records(datasetVersion, pageSize)
  const parentRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total ?? 0
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => RECORD_ROW_ESTIMATE,
    getScrollElement: () => parentRef.current,
    overscan: 8,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastItem = virtualItems.at(-1)
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query

  useEffect(() => {
    if (
      shouldFetchNextRecordPage({
        hasNextPage,
        isFetchingNextPage,
        lastIndex: lastItem?.index,
        loaded: rows.length,
      })
    ) {
      void fetchNextPage()
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, lastItem?.index, rows.length])

  if (query.isLoading) return <Spinner />
  if (query.isError) {
    return (
      <V2ReadErrorState
        error={query.error}
        identifier={datasetVersion}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (rows.length === 0) return <EmptyState>{t('v2.records.empty')}</EmptyState>

  return (
    <div>
      <div className="px-5 py-3 text-muted-foreground text-sm">
        <span>{t('v2.records.loaded', { loaded: rows.length, total })}</span>
      </div>
      <button
        aria-controls={listId}
        className="sr-only rounded-[4px] focus:not-sr-only focus:mb-2 focus:inline-flex focus:h-9 focus:items-center focus:border focus:border-primary focus:px-3 focus:text-sm"
        onKeyDown={(event) => {
          handleVirtualListKeyDown(event, parentRef.current, virtualizer.getTotalSize())
          if (event.key === 'End' && hasNextPage && !isFetchingNextPage) void fetchNextPage()
        }}
        type="button"
      >
        {t('v2.records.listLabel')}
      </button>
      <div
        className="h-[min(64vh,720px)] overflow-auto border-border border-t"
        id={listId}
        ref={parentRef}
      >
        <ol
          aria-label={t('v2.records.listLabel')}
          className="relative m-0 w-full list-none p-0"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((item) => {
            const record = rows[item.index]
            if (record === undefined) return null

            return (
              <li
                className="absolute w-full"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <RecordSummaryRow datasetVersion={datasetVersion} record={record} />
              </li>
            )
          })}
        </ol>
      </div>
      {isFetchingNextPage ? (
        <div className="border-border border-t p-3">
          <Spinner label={t('v2.records.loadingMore')} />
        </div>
      ) : null}
      {!hasNextPage ? (
        <div className="border-border border-t px-5 py-3 text-center text-muted-foreground text-sm">
          {t('v2.records.complete', { total })}
        </div>
      ) : null}
    </div>
  )
}

export function virtualListScrollTarget({
  clientHeight,
  current,
  key,
  total,
}: {
  clientHeight: number
  current: number
  key: string
  total: number
}): number | null {
  const max = Math.max(0, total - clientHeight)
  switch (key) {
    case 'ArrowDown':
      return Math.min(max, current + RECORD_ROW_ESTIMATE)
    case 'ArrowUp':
      return Math.max(0, current - RECORD_ROW_ESTIMATE)
    case 'PageDown':
      return Math.min(max, current + clientHeight)
    case 'PageUp':
      return Math.max(0, current - clientHeight)
    case 'Home':
      return 0
    case 'End':
      return max
    default:
      return null
  }
}

function handleVirtualListKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  viewport: HTMLDivElement | null,
  total: number,
): void {
  if (viewport === null) return
  const target = virtualListScrollTarget({
    clientHeight: viewport.clientHeight,
    current: viewport.scrollTop,
    key: event.key,
    total,
  })
  if (target === null) return
  event.preventDefault()
  viewport.scrollTo({ behavior: 'auto', top: target })
}

export function shouldFetchNextRecordPage({
  hasNextPage,
  isFetchingNextPage,
  lastIndex,
  loaded,
}: {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  lastIndex: number | undefined
  loaded: number
}): boolean {
  return lastIndex !== undefined && lastIndex >= loaded - 1 && hasNextPage && !isFetchingNextPage
}

export function selectRecordRows(
  rows: readonly RecordSummaryV2[],
  indices: readonly number[],
): RecordSummaryV2[] {
  return indices.flatMap((index) => rows[index] ?? [])
}
