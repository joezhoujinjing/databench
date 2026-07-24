import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'

export function LazySection({
  children,
  className,
  count,
  title,
}: {
  children: ReactNode | (() => ReactNode)
  className?: string
  count?: number
  title: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const contentId = useId()

  return (
    <section className={cn('rounded-[5px] border border-border bg-background/35', className)}>
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left font-medium text-sm transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="shrink-0 text-muted-foreground" size={16} />
        ) : (
          <ChevronRight aria-hidden="true" className="shrink-0 text-muted-foreground" size={16} />
        )}
        <span className="min-w-0 flex-1">{title}</span>
        {count === undefined ? null : (
          <span className="text-dim-foreground tabular-nums">{count}</span>
        )}
        <span className="sr-only">{open ? t('v2.record.collapse') : t('v2.record.expand')}</span>
      </button>
      {open ? (
        <div className="border-border border-t px-4 py-4" id={contentId}>
          {typeof children === 'function' ? children() : children}
        </div>
      ) : null}
    </section>
  )
}
