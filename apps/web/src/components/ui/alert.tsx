import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils.js'

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[5px] border border-border bg-surface-soft p-4 text-sm', className)}
      role="status"
      {...props}
    />
  )
}
