import type { VirtualItem } from '@tanstack/react-virtual'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useInfiniteSamples } from '@/api/hooks.js'
import type { Sample } from '@/api/types.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { sampleKind } from '@/lib/sample-display.js'
import { SampleView } from './SampleView.js'

interface FetchDecision {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  lastIndex: number | undefined
  loaded: number
}

export function VirtualizedSamples({
  kindFilter,
  kindTotal,
  pageSize,
  refName,
}: {
  kindFilter?: string | null
  kindTotal?: number
  pageSize: number
  refName: string
}) {
  const { t } = useTranslation()
  const query = useInfiniteSamples(refName, pageSize)
  const parentRef = useRef<HTMLDivElement>(null)
  const rows: Sample[] = query.data?.pages.flatMap((page) => page.items as Sample[]) ?? []
  const total = query.data?.pages[0]?.total ?? 0
  const loaded = rows.length
  const visibleRows = filterSamplesByKind(rows, kindFilter)
  const visibleTotal = kindTotal ?? total

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    estimateSize: () => 200,
    getScrollElement: () => parentRef.current,
    overscan: 6,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVirtualItem = virtualItems.at(-1)
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query

  useEffect(() => {
    if (kindFilter && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage()
      return
    }

    if (
      shouldFetchNextSamplePage({
        hasNextPage,
        isFetchingNextPage,
        lastIndex: lastVirtualItem?.index,
        loaded,
      })
    ) {
      void fetchNextPage()
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, kindFilter, lastVirtualItem?.index, loaded])

  if (query.isLoading) {
    return <Spinner />
  }

  if (query.isError) {
    return <ErrorState error={query.error} />
  }

  if (visibleRows.length === 0) {
    if (kindFilter && (hasNextPage || isFetchingNextPage)) {
      return <Spinner label={t('detail.loadingMore')} />
    }

    return <EmptyState>{t('detail.noSamples')}</EmptyState>
  }

  return (
    <div className="space-y-3">
      <div className="px-5 pt-4 text-muted-foreground text-sm">
        {t('detail.loadedOf', { loaded: visibleRows.length, total: visibleTotal })}
      </div>
      <div className="h-[600px] overflow-auto border-border border-t bg-background" ref={parentRef}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => {
            const sample = visibleRows[item.index]

            if (sample === undefined) {
              return null
            }

            return (
              <div
                className="absolute w-full"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <SampleView index={item.index + 1} sample={sample} />
              </div>
            )
          })}
        </div>
      </div>
      {isFetchingNextPage ? <Spinner label={t('detail.loadingMore')} /> : null}
      {!hasNextPage && visibleRows.length > 0 ? (
        <div className="text-center text-muted-foreground text-sm">
          {t('detail.allLoaded', { total: visibleTotal })}
        </div>
      ) : null}
    </div>
  )
}

export function shouldFetchNextSamplePage({
  hasNextPage,
  isFetchingNextPage,
  lastIndex,
  loaded,
}: FetchDecision): boolean {
  return lastIndex !== undefined && lastIndex >= loaded - 1 && hasNextPage && !isFetchingNextPage
}

export function selectVirtualRows<T>(
  rows: readonly T[],
  virtualItems: readonly Pick<VirtualItem, 'index'>[],
): T[] {
  return virtualItems.flatMap((item) => {
    const row = rows[item.index]
    return row === undefined ? [] : [row]
  })
}

export function filterSamplesByKind(
  rows: readonly Sample[],
  kindFilter: string | null | undefined,
): Sample[] {
  return kindFilter ? rows.filter((sample) => sampleKind(sample) === kindFilter) : [...rows]
}
