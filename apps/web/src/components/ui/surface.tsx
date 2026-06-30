import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils.js'

export function PageShell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-5', className)} {...props} />
}

export function PageHeader({
  actions,
  className,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode
  className?: string
  description?: ReactNode
  eyebrow?: ReactNode
  title: ReactNode
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-5 pb-2', className)}>
      <div className="min-w-0 space-y-2">
        {eyebrow ? (
          <div className="text-muted-foreground text-sm leading-none">{eyebrow}</div>
        ) : null}
        <h1 className="text-balance font-semibold text-[2rem] leading-[1.08] tracking-normal">
          {title}
        </h1>
        {description ? (
          <p className="max-w-3xl text-muted-foreground text-[0.95rem] leading-6">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>
      ) : null}
    </div>
  )
}

export function Surface({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-[6px] border border-border bg-surface/82 shadow-[0_1px_0_rgba(255,255,255,0.025)_inset,0_22px_70px_rgba(0,0,0,0.16)]',
        className,
      )}
      {...props}
    />
  )
}

export function SurfaceHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-border border-b px-5 py-4.5', className)} {...props} />
}

export function SurfaceTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('font-semibold text-[1.05rem] leading-tight', className)} {...props} />
}

export function SurfaceDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-2 text-muted-foreground text-sm leading-6', className)} {...props} />
}

export function SurfaceBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function SplitSurface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'grid overflow-hidden rounded-[6px] border border-border bg-surface/82 shadow-[0_1px_0_rgba(255,255,255,0.025)_inset,0_22px_70px_rgba(0,0,0,0.16)]',
        className,
      )}
      {...props}
    />
  )
}

export function MetricStrip({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'grid rounded-[6px] border border-border bg-surface/82 sm:grid-cols-2 lg:grid-cols-5',
        className,
      )}
      {...props}
    />
  )
}

export function MetricItem({
  className,
  label,
  value,
}: {
  className?: string
  label: ReactNode
  value: ReactNode
}) {
  return (
    <div
      className={cn(
        'min-w-0 border-border border-b px-5 py-4 last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0',
        className,
      )}
    >
      <div className="text-muted-foreground text-sm leading-none">{label}</div>
      <div className="mt-3 min-h-6 break-words text-[1.03rem] leading-6">{value}</div>
    </div>
  )
}

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-3', className)} {...props} />
}

export function SectionLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'font-medium text-muted-foreground text-[0.72rem] uppercase tracking-[0.12em]',
        className,
      )}
      {...props}
    />
  )
}

export function KeyValueGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-3 text-sm', className)} {...props} />
}

export function KeyValueRow({
  children,
  className,
  label,
  value,
}: {
  children?: ReactNode
  className?: string
  label: ReactNode
  value?: ReactNode
}) {
  return (
    <div className={cn('grid min-w-0 gap-3 sm:grid-cols-[9.5rem_1fr]', className)}>
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words leading-6">{value ?? children}</div>
    </div>
  )
}
