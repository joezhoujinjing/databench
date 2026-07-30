import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { TextInput } from '@/components/ui/input.js'
import { cn } from '@/lib/utils.js'
import { evalScopeClient } from '../../api/client.js'
import { benchmarkSuggestions, replaceLastBenchmark } from '../../domain/form/benchmark.js'

export function BenchmarkAutocomplete({
  disabled,
  error,
  id,
  onChange,
  value,
}: {
  readonly disabled?: boolean | undefined
  readonly error?: string | undefined
  readonly id: string
  readonly onChange: (value: string) => void
  readonly value: string
}) {
  const [names, setNames] = useState<readonly string[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listboxId = `${useId()}-benchmarks`
  const rootRef = useRef<HTMLDivElement>(null)
  const suggestions = useMemo(() => benchmarkSuggestions(value, names), [names, value])

  useEffect(() => {
    const controller = new AbortController()
    void evalScopeClient
      .request('benchmarks', { query: { all: true }, signal: controller.signal })
      .then((response) => {
        setNames([
          ...(response.text ?? []).map((benchmark) => benchmark.name),
          ...(response.multimodal ?? []).map((benchmark) => benchmark.name),
        ])
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setActive(-1)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const commit = (benchmark: string) => {
    onChange(replaceLastBenchmark(value, benchmark))
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      setOpen(true)
      setActive((current) => {
        if (event.key === 'ArrowDown') return Math.min(current + 1, suggestions.length - 1)
        return Math.max(current <= 0 ? 0 : current - 1, 0)
      })
      return
    }
    if (event.key === 'Enter' && open && active >= 0) {
      event.preventDefault()
      const suggestion = suggestions[active]
      if (suggestion !== undefined) commit(suggestion)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <TextInput
        aria-activedescendant={open && active >= 0 ? `${listboxId}-option-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        aria-expanded={open}
        aria-invalid={error === undefined ? undefined : true}
        autoComplete="off"
        disabled={disabled}
        id={id}
        onChange={(event) => {
          const next = event.currentTarget.value
          onChange(next)
          const nextSuggestions = benchmarkSuggestions(next, names)
          setOpen(nextSuggestions.length > 0)
          setActive(nextSuggestions.length > 0 ? 0 : -1)
        }}
        onFocus={() => setOpen(suggestions.length > 0)}
        onKeyDown={onKeyDown}
        placeholder="general_qa"
        role="combobox"
        value={value}
      />
      {open && suggestions.length > 0 ? (
        <div
          className="absolute right-0 left-0 z-40 mt-1.5 max-h-52 overflow-auto rounded-[6px] border border-border-strong bg-surface-raised p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
          id={listboxId}
          role="listbox"
        >
          {suggestions.map((name, index) => (
            <button
              aria-selected={index === active}
              className={cn(
                'min-h-10 w-full rounded-[4px] px-3 text-left text-sm transition',
                index === active
                  ? 'bg-primary/16 text-foreground'
                  : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
              )}
              id={`${listboxId}-option-${index}`}
              key={name}
              onClick={() => commit(name)}
              onPointerEnter={() => setActive(index)}
              role="option"
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
