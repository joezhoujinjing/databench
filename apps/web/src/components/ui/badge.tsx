import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils.js'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: 'default' | 'blue' | 'green' | 'orange' | 'violet' | 'muted'
}

export function Badge({ className, tone = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-[4px] border px-2 font-medium text-[0.73rem] leading-none',
        tone === 'default' && 'border-border bg-surface-soft text-muted-foreground',
        tone === 'blue' && 'border-sky-500/45 bg-sky-500/10 text-sky-300',
        tone === 'green' && 'border-success/45 bg-success/10 text-success',
        tone === 'orange' && 'border-warning/45 bg-warning/10 text-warning',
        tone === 'violet' && 'border-primary/55 bg-accent text-accent-foreground',
        tone === 'muted' && 'border-border bg-transparent text-dim-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function KindBadge({ kind }: { kind: string }) {
  const normalized = kind.toLowerCase()
  const tone = normalized.includes('preference')
    ? 'violet'
    : normalized.includes('active') || normalized.includes('ready')
      ? 'green'
      : normalized.includes('rl')
        ? 'orange'
        : 'blue'

  return <Badge tone={tone}>{kind}</Badge>
}

export function StatusDot({
  className,
  tone = 'green',
}: {
  className?: string
  tone?: 'green' | 'red' | 'amber'
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 rounded-full shadow-[0_0_18px_currentColor]',
        tone === 'green' && 'bg-success',
        tone === 'red' && 'bg-danger',
        tone === 'amber' && 'bg-warning',
        className,
      )}
    />
  )
}
