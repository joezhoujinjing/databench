import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils.js'

export interface TabItem<T extends string> {
  label: string
  value: T
}

export function SegmentedTabs<T extends string>({
  ariaLabel,
  className,
  items,
  onChange,
  panelId,
  value,
}: {
  ariaLabel: string
  className?: string
  items: readonly TabItem<T>[]
  onChange: (value: T) => void
  panelId: string
  value: T
}) {
  const selected = items.some((item) => item.value === value) ? value : items[0]?.value
  const refs = useRef(new Map<T, HTMLButtonElement>())

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = moveTabIndex(index, items.length, event.key)
    if (nextIndex === null) return
    event.preventDefault()
    const next = items[nextIndex]
    if (next === undefined) return
    onChange(next.value)
    refs.current.get(next.value)?.focus()
  }

  return (
    <div
      aria-label={ariaLabel}
      className={cn('flex min-h-10 items-stretch gap-6 border-border border-b', className)}
      role="tablist"
    >
      {items.map((item, index) => (
        <button
          aria-controls={panelId}
          aria-selected={item.value === selected}
          className={cn(
            'relative px-0.5 text-sm text-muted-foreground transition-colors after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-0.5 after:origin-center after:scale-x-0 after:bg-primary after:transition-transform hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
            item.value === selected && 'font-medium text-foreground after:scale-x-100',
          )}
          id={`${panelId}-tab-${item.value}`}
          key={item.value}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
          ref={(element) => {
            if (element === null) refs.current.delete(item.value)
            else refs.current.set(item.value, element)
          }}
          role="tab"
          tabIndex={item.value === selected ? 0 : -1}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export interface AccessibleTabItem<T extends string> {
  readonly label: string
  readonly panel: ReactNode
  readonly value: T
}

export function Tabs<T extends string>({
  ariaLabel,
  className,
  items,
  onChange,
  value,
}: {
  ariaLabel: string
  className?: string
  items: readonly AccessibleTabItem<T>[]
  onChange: (value: T) => void
  value: T
}) {
  const baseId = useId()
  const selected = items.some((item) => item.value === value) ? value : items[0]?.value
  const [focusValue, setFocusValue] = useState<T | undefined>(selected)
  const effectiveFocus = items.some((item) => item.value === focusValue) ? focusValue : selected
  const refs = useRef(new Map<T, HTMLButtonElement>())

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = moveTabIndex(index, items.length, event.key)
    if (nextIndex === null) return
    event.preventDefault()
    const next = items[nextIndex]
    if (next === undefined) return
    setFocusValue(next.value)
    refs.current.get(next.value)?.focus()
  }

  return (
    <div className={cn('space-y-5', className)}>
      <div
        aria-label={ariaLabel}
        className="inline-flex rounded-[5px] border border-border bg-background/65 p-1"
        role="tablist"
      >
        {items.map((item, index) => {
          const active = item.value === selected
          return (
            <button
              aria-controls={`${baseId}-panel-${item.value}`}
              aria-selected={active}
              className={cn(
                'min-h-9 rounded-[4px] px-4 text-sm text-muted-foreground transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                active && 'bg-accent text-accent-foreground',
                !active && 'hover:text-foreground',
              )}
              id={`${baseId}-tab-${item.value}`}
              key={item.value}
              onClick={() => onChange(item.value)}
              onFocus={() => setFocusValue(item.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(element) => {
                if (element === null) refs.current.delete(item.value)
                else refs.current.set(item.value, element)
              }}
              role="tab"
              tabIndex={item.value === effectiveFocus ? 0 : -1}
              type="button"
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {items.map((item) => (
        <div
          aria-labelledby={`${baseId}-tab-${item.value}`}
          hidden={item.value !== selected}
          id={`${baseId}-panel-${item.value}`}
          key={item.value}
          role="tabpanel"
        >
          {item.value === selected ? item.panel : null}
        </div>
      ))}
    </div>
  )
}

export function moveTabIndex(index: number, length: number, key: string): number | null {
  if (length <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'ArrowLeft') return (index - 1 + length) % length
  if (key === 'ArrowRight') return (index + 1) % length
  return null
}
