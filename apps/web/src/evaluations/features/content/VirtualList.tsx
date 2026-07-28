import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useRef } from 'react'

export function VirtualList<T>({
  estimateSize = 180,
  getKey,
  items,
  maxHeight = 760,
  renderItem,
  threshold = 30,
}: {
  readonly estimateSize?: number
  readonly getKey: (item: T, index: number) => string | number
  readonly items: readonly T[]
  readonly maxHeight?: number
  readonly renderItem: (item: T, index: number) => ReactNode
  readonly threshold?: number
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => getKey(items[index] as T, index),
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 5,
  })

  if (items.length <= threshold) {
    return (
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderItem(item, index)}</div>
        ))}
      </div>
    )
  }

  return (
    <div
      className="overflow-y-auto rounded-[5px] border border-border bg-background/20 p-2"
      ref={parentRef}
      style={{ maxHeight }}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          if (item === undefined) return null
          return (
            <div
              className="absolute top-0 left-0 w-full pb-3"
              data-index={virtualRow.index}
              key={getKey(item, virtualRow.index)}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
