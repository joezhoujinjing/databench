import { ArrowDownAZ, ArrowUpAZ, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'

export type ReportFilterValues = {
  readonly datasets: readonly string[]
  readonly models: readonly string[]
  readonly scoreMax: number | undefined
  readonly scoreMin: number | undefined
  readonly sortBy: 'dataset' | 'model' | 'score' | 'time'
  readonly sortOrder: 'asc' | 'desc'
}

function MultiSelect({
  label,
  onChange,
  options,
  selected,
}: {
  readonly label: string
  readonly onChange: (values: string[]) => void
  readonly options: readonly string[]
  readonly selected: readonly string[]
}) {
  return (
    <details className="relative">
      <summary className="flex h-10 cursor-pointer list-none items-center rounded-[4px] border border-border bg-background/35 px-3 text-sm hover:border-border-strong">
        {label}
        {selected.length > 0 ? ` (${selected.length})` : ''}
      </summary>
      <div className="absolute top-full left-0 z-20 mt-1 max-h-64 min-w-56 overflow-y-auto rounded-[5px] border border-border bg-surface p-2 shadow-2xl">
        {options.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">—</p>
        ) : (
          options.map((option) => (
            <label
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-surface-hover"
              key={option}
            >
              <input
                checked={selected.includes(option)}
                className="accent-primary"
                onChange={() =>
                  onChange(
                    selected.includes(option)
                      ? selected.filter((value) => value !== option)
                      : [...selected, option],
                  )
                }
                type="checkbox"
              />
              <span className="break-words">{option}</span>
            </label>
          ))
        )}
      </div>
    </details>
  )
}

export function ReportFilters({
  availableDatasets,
  availableModels,
  onChange,
  onSearchChange,
  search,
  values,
}: {
  readonly availableDatasets: readonly string[]
  readonly availableModels: readonly string[]
  readonly onChange: (values: ReportFilterValues) => void
  readonly onSearchChange: (value: string) => void
  readonly search: string
  readonly values: ReportFilterValues
}) {
  const { t } = useTranslation()
  const update = (patch: Partial<ReportFilterValues>) => onChange({ ...values, ...patch })
  const chips = [
    ...values.models.map((value) => ({
      key: `model-${value}`,
      label: `model:${value}`,
      remove: () => update({ models: values.models.filter((item) => item !== value) }),
    })),
    ...values.datasets.map((value) => ({
      key: `dataset-${value}`,
      label: `dataset:${value}`,
      remove: () => update({ datasets: values.datasets.filter((item) => item !== value) }),
    })),
    ...(values.scoreMin === undefined
      ? []
      : [
          {
            key: 'score-min',
            label: `score≥${values.scoreMin}`,
            remove: () => update({ scoreMin: undefined }),
          },
        ]),
    ...(values.scoreMax === undefined
      ? []
      : [
          {
            key: 'score-max',
            label: `score≤${values.scoreMax}`,
            remove: () => update({ scoreMax: undefined }),
          },
        ]),
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          className="min-w-64 flex-1"
          htmlFor="reports-search"
          label={t('evaluations.reports.filters.searchLabel')}
        >
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <input
              className="h-10 w-full rounded-[4px] border border-border bg-background/35 pr-3 pl-9 text-sm outline-none focus:border-primary"
              id="reports-search"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('evaluations.reports.filters.search')}
              value={search}
            />
          </div>
        </Field>
        <MultiSelect
          label={t('evaluations.reports.filters.model')}
          onChange={(models) => update({ models })}
          options={availableModels}
          selected={values.models}
        />
        <MultiSelect
          label={t('evaluations.reports.filters.dataset')}
          onChange={(datasets) => update({ datasets })}
          options={availableDatasets}
          selected={values.datasets}
        />
        <Field
          className="w-24"
          htmlFor="reports-score-min"
          label={t('evaluations.reports.filters.scoreMin')}
        >
          <input
            className="h-10 rounded-[4px] border border-border bg-background/35 px-2 text-sm outline-none focus:border-primary"
            id="reports-score-min"
            max={1}
            min={0}
            onChange={(event) =>
              update({
                scoreMin: event.target.value === '' ? undefined : Number(event.target.value),
              })
            }
            step="0.01"
            type="number"
            value={values.scoreMin ?? ''}
          />
        </Field>
        <Field
          className="w-24"
          htmlFor="reports-score-max"
          label={t('evaluations.reports.filters.scoreMax')}
        >
          <input
            className="h-10 rounded-[4px] border border-border bg-background/35 px-2 text-sm outline-none focus:border-primary"
            id="reports-score-max"
            max={1}
            min={0}
            onChange={(event) =>
              update({
                scoreMax: event.target.value === '' ? undefined : Number(event.target.value),
              })
            }
            step="0.01"
            type="number"
            value={values.scoreMax ?? ''}
          />
        </Field>
        <Field
          className="w-36"
          htmlFor="reports-sort"
          label={t('evaluations.reports.filters.sortBy')}
        >
          <select
            className="h-10 rounded-[4px] border border-border bg-background/35 px-3 text-sm outline-none focus:border-primary"
            id="reports-sort"
            onChange={(event) =>
              update({ sortBy: event.target.value as ReportFilterValues['sortBy'] })
            }
            value={values.sortBy}
          >
            {(['time', 'score', 'model', 'dataset'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`evaluations.reports.filters.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button
          aria-label={values.sortOrder === 'asc' ? 'Ascending' : 'Descending'}
          onClick={() => update({ sortOrder: values.sortOrder === 'asc' ? 'desc' : 'asc' })}
          size="sm"
          variant="outline"
        >
          {values.sortOrder === 'asc' ? (
            <ArrowUpAZ aria-hidden="true" size={14} />
          ) : (
            <ArrowDownAZ aria-hidden="true" size={14} />
          )}
        </Button>
      </div>
      {chips.length > 0 ? (
        <section
          className="flex flex-wrap items-center gap-2"
          aria-label={t('evaluations.reports.activeFilters')}
        >
          {chips.map((chip) => (
            <button
              className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border bg-surface-soft px-3 font-mono text-xs text-muted-foreground hover:text-foreground"
              key={chip.key}
              onClick={chip.remove}
              type="button"
            >
              {chip.label}
              <X aria-hidden="true" size={11} />
            </button>
          ))}
          <button
            className="min-h-8 px-2 text-primary text-xs hover:underline"
            onClick={() =>
              onChange({
                datasets: [],
                models: [],
                scoreMax: undefined,
                scoreMin: undefined,
                sortBy: values.sortBy,
                sortOrder: values.sortOrder,
              })
            }
            type="button"
          >
            {t('evaluations.empty.action.clearFilters')}
          </button>
        </section>
      ) : null}
    </div>
  )
}
