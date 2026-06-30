import { cn } from '@/lib/utils.js'

export interface TabItem<T extends string> {
  label: string
  value: T
}

export function SegmentedTabs<T extends string>({
  items,
  onChange,
  value,
}: {
  items: readonly TabItem<T>[]
  onChange: (value: T) => void
  value: T
}) {
  return (
    <div className="inline-flex rounded-[5px] border border-border bg-background/65 p-1">
      {items.map((item) => (
        <button
          className={cn(
            'h-9 rounded-[4px] px-4 text-sm text-muted-foreground transition',
            item.value === value &&
              'bg-accent text-accent-foreground shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]',
            item.value !== value && 'hover:text-foreground',
          )}
          key={item.value}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
