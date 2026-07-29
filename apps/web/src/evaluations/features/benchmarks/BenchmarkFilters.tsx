import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'

export function BenchmarkFilters({
  availableTags,
  onSearchChange,
  onTagsChange,
  search,
  tags,
}: {
  readonly availableTags: readonly string[]
  readonly onSearchChange: (value: string) => void
  readonly onTagsChange: (value: string[]) => void
  readonly search: string
  readonly tags: readonly string[]
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 border-border border-y py-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
        <label className="relative" htmlFor="benchmark-search">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <span className="sr-only">{t('evaluations.benchmarks.search')}</span>
          <TextInput
            className="pl-9"
            id="benchmark-search"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('evaluations.benchmarks.search')}
            value={search}
          />
        </label>
        <fieldset className="flex max-h-28 flex-wrap gap-1.5 overflow-auto">
          <legend className="sr-only">{t('evaluations.benchmarks.filterByTag')}</legend>
          {availableTags.map((tag) => (
            <Button
              aria-pressed={tags.includes(tag)}
              key={tag}
              onClick={() =>
                onTagsChange(
                  tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag],
                )
              }
              size="sm"
              variant={tags.includes(tag) ? 'default' : 'outline'}
            >
              {tag}
            </Button>
          ))}
        </fieldset>
      </div>
      {search || tags.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {t('evaluations.reports.activeFilters')}
          </span>
          {search ? (
            <Badge className="gap-1" tone="blue">
              “{search}”
              <button
                aria-label={t('evaluations.common.remove')}
                onClick={() => onSearchChange('')}
                type="button"
              >
                <X aria-hidden="true" size={11} />
              </button>
            </Badge>
          ) : null}
          {tags.map((tag) => (
            <Badge className="gap-1" key={tag} tone="muted">
              {tag}
              <button
                aria-label={`${t('evaluations.common.remove')} ${tag}`}
                onClick={() => onTagsChange(tags.filter((item) => item !== tag))}
                type="button"
              >
                <X aria-hidden="true" size={11} />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
