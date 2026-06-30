import { useVirtualizer } from '@tanstack/react-virtual'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Term } from '@/api/types.js'
import { EmptyState } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { formatInteger } from '@/lib/format.js'

export function VirtualizedTerms({
  editing = false,
  onAliasesChange,
  onCanonicalChange,
  onRemoveTerm,
  terms,
}: {
  editing?: boolean
  onAliasesChange?: (index: number, aliases: string[]) => void
  onCanonicalChange?: (index: number, canonical: string) => void
  onRemoveTerm?: (index: number) => void
  terms: readonly Term[]
}) {
  const { t } = useTranslation()
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: terms.length,
    estimateSize: () => (editing ? 84 : 68),
    getScrollElement: () => parentRef.current,
    overscan: 8,
  })

  if (terms.length === 0) {
    return <EmptyState>{t('vocab.noTerms')}</EmptyState>
  }

  return (
    <div className="h-[28rem] overflow-auto rounded-[5px] border border-border" ref={parentRef}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const term = terms[virtualRow.index]

          if (!term) {
            return null
          }

          return (
            <div
              className="absolute top-0 left-0 w-full border-border border-b bg-surface px-4 py-3 last:border-b-0"
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {editing ? (
                <EditableTermRow
                  index={virtualRow.index}
                  onAliasesChange={onAliasesChange}
                  onCanonicalChange={onCanonicalChange}
                  onRemoveTerm={onRemoveTerm}
                  term={term}
                />
              ) : (
                <ReadOnlyTermRow term={term} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function parseAliases(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function ReadOnlyTermRow({ term }: { term: Term }) {
  const { t } = useTranslation()
  const count = readCount(term)

  return (
    <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="truncate font-semibold text-[0.98rem]" title={term.canonical}>
          {term.canonical}
        </div>
        {count !== undefined ? (
          <div className="mt-1 text-dim-foreground text-xs">
            {t('vocab.seenCount', { count: formatInteger(count) })}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        {term.aliases.length > 0 ? (
          term.aliases.map((alias) => (
            <Badge className="max-w-full" key={alias} tone="muted" title={alias}>
              <span className="truncate">{alias}</span>
            </Badge>
          ))
        ) : (
          <span className="text-dim-foreground text-sm">{t('common.none')}</span>
        )}
      </div>
    </div>
  )
}

function EditableTermRow({
  index,
  onAliasesChange,
  onCanonicalChange,
  onRemoveTerm,
  term,
}: {
  index: number
  onAliasesChange: ((index: number, aliases: string[]) => void) | undefined
  onCanonicalChange: ((index: number, canonical: string) => void) | undefined
  onRemoveTerm: ((index: number) => void) | undefined
  term: Term
}) {
  const { t } = useTranslation()

  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(11rem,0.42fr)_minmax(0,1fr)_2.5rem]">
      <TextInput
        aria-label={t('vocab.canonicalPlaceholder')}
        className="h-10"
        onChange={(event) => onCanonicalChange?.(index, event.currentTarget.value)}
        placeholder={t('vocab.canonicalPlaceholder')}
        value={term.canonical}
      />
      <AliasInput
        onCommit={(aliases) => onAliasesChange?.(index, aliases)}
        placeholder={t('vocab.aliasesPlaceholder')}
        value={term.aliases.join(', ')}
      />
      <Button
        aria-label={t('vocab.removeTerm')}
        className="size-10 px-0"
        onClick={() => onRemoveTerm?.(index)}
        title={t('vocab.removeTerm')}
        type="button"
        variant="outline"
      >
        <Trash2 aria-hidden="true" size={15} />
      </Button>
    </div>
  )
}

function AliasInput({
  onCommit,
  placeholder,
  value,
}: {
  onCommit: (aliases: string[]) => void
  placeholder: string
  value: string
}) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) {
      setText(value)
    }
  }, [focused, value])

  return (
    <TextInput
      className="h-10"
      onBlur={() => {
        setFocused(false)
        onCommit(parseAliases(text))
      }}
      onChange={(event) => setText(event.currentTarget.value)}
      onFocus={() => setFocused(true)}
      placeholder={placeholder}
      value={text}
    />
  )
}

function readCount(term: Term): number | undefined {
  const count = term.meta.count
  return typeof count === 'number' ? count : undefined
}
