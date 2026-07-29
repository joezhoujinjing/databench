import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils.js'

type TableContainerProps = ComponentPropsWithRef<'section'> & { 'aria-label': string }

export function TableContainer({ className, ...props }: TableContainerProps) {
  return (
    <section
      className={cn('w-full overflow-x-auto rounded-[5px] border border-border', className)}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: enables keyboard scrolling for wide tables on narrow screens.
      tabIndex={0}
      {...props}
    />
  )
}

export function Table({ className, ...props }: ComponentPropsWithRef<'table'>) {
  return <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
}

export function TableHeader({ className, ...props }: ComponentPropsWithRef<'thead'>) {
  return <thead className={cn('bg-surface-soft text-muted-foreground', className)} {...props} />
}

export function TableBody({ className, ...props }: ComponentPropsWithRef<'tbody'>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />
}

export function TableRow({ className, ...props }: ComponentPropsWithRef<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-hover/55', className)} {...props} />
}

export function TableHead({ className, ...props }: ComponentPropsWithRef<'th'>) {
  return (
    <th
      className={cn('h-10 px-3 font-medium text-xs uppercase tracking-[0.08em]', className)}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: ComponentPropsWithRef<'td'>) {
  return <td className={cn('px-3 py-2.5 align-top', className)} {...props} />
}
