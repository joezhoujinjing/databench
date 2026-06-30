import { Check, ChevronDown } from 'lucide-react'
import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils.js'

const controlClass =
  'w-full rounded-[4px] border border-border bg-background/70 px-3 py-2.5 text-sm text-foreground outline-none transition hover:border-border-strong hover:bg-background focus:border-primary focus:shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_72%,transparent)] placeholder:text-dim-foreground disabled:cursor-not-allowed disabled:opacity-55'

export interface SelectOption<T extends string | number> {
  disabled?: boolean
  label: ReactNode
  value: T
}

export interface SelectInputProps<T extends string | number> {
  'aria-label'?: string
  className?: string
  disabled?: boolean
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  value: T
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClass, 'resize-y', className)} {...props} />
}

export function SelectInput<T extends string | number>({
  'aria-label': ariaLabel,
  className,
  disabled = false,
  onValueChange,
  options,
  value,
}: SelectInputProps<T>) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  function commit(nextValue: T) {
    onValueChange(nextValue)
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen((current) => !current)
      return
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }

    event.preventDefault()
    const enabled = options.filter((option) => !option.disabled)
    if (enabled.length === 0) {
      return
    }

    const currentIndex = enabled.findIndex((option) => option.value === value)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + direction + enabled.length) % enabled.length
    const next = enabled[nextIndex]

    if (next) {
      commit(next.value)
    }
  }

  return (
    <div className={cn('relative inline-block min-w-0', className)} ref={rootRef}>
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={cn(
          controlClass,
          'flex h-full min-h-10 items-center justify-between gap-3 pr-2.5 text-left',
          open &&
            'border-primary shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_72%,transparent)]',
        )}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <span className="min-w-0 truncate">{selected?.label ?? String(value)}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'shrink-0 text-dim-foreground transition',
            open && 'rotate-180 text-primary',
          )}
          size={16}
        />
      </button>

      {open ? (
        <div
          className="absolute top-[calc(100%+0.375rem)] right-0 z-50 max-h-72 min-w-full overflow-auto rounded-[6px] border border-border-strong bg-surface-raised p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
          id={id}
          role="listbox"
        >
          {options.map((option) => {
            const active = option.value === value

            return (
              <button
                aria-selected={active}
                className={cn(
                  'flex h-9 w-full items-center justify-between gap-3 rounded-[4px] px-2.5 text-left text-sm transition',
                  active
                    ? 'bg-primary/16 text-foreground'
                    : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                  option.disabled && 'cursor-not-allowed opacity-50',
                )}
                disabled={option.disabled}
                key={String(option.value)}
                onClick={() => commit(option.value)}
                role="option"
                type="button"
              >
                <span className="truncate">{option.label}</span>
                {active ? <Check aria-hidden="true" className="text-primary" size={15} /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
