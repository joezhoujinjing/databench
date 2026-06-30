import type { ReactNode } from 'react'
import { cn } from '@/lib/utils.js'

export function Field({
  children,
  className,
  hint,
  label,
}: {
  children: ReactNode
  className?: string
  hint?: ReactNode
  label: ReactNode
}) {
  return (
    <div className={cn('grid gap-2 text-sm', className)}>
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-dim-foreground text-xs leading-5">{hint}</span> : null}
    </div>
  )
}

export function FormError({ children }: { children: ReactNode }) {
  return <div className="text-danger text-sm leading-6">{children}</div>
}
