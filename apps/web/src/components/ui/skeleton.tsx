import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils.js'

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-[3px] bg-surface-soft', className)} {...props} />
}
