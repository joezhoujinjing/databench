import {
  type ButtonHTMLAttributes,
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
} from 'react'
import { cn } from '@/lib/utils.js'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly asChild?: boolean
  readonly size?: 'sm' | 'md' | 'lg'
  readonly variant?: 'default' | 'ghost' | 'outline' | 'quiet'
}

export function Button({
  asChild = false,
  className,
  size = 'md',
  variant = 'default',
  ...props
}: ButtonProps) {
  const classes = cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[4px] font-medium text-sm transition duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:translate-y-px disabled:pointer-events-none disabled:opacity-55',
    size === 'sm' && 'h-8 px-2.5',
    size === 'md' && 'h-10 px-4',
    size === 'lg' && 'h-11 px-6',
    variant === 'ghost' && 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
    variant === 'outline' &&
      'border border-border bg-background/35 text-foreground hover:border-border-strong hover:bg-surface-hover',
    variant === 'quiet' && 'text-accent-foreground hover:text-foreground',
    variant === 'default' &&
      'bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset,0_12px_32px_rgba(124,92,255,0.2)] hover:bg-primary-hover',
    className,
  )

  if (asChild) {
    const child = Children.only(props.children)

    if (!isValidElement(child)) {
      return null
    }

    const element = child as ReactElement<{ className?: string }>

    return cloneElement(element, {
      className: cn(classes, element.props.className),
    })
  }

  return <button className={classes} {...props} />
}
