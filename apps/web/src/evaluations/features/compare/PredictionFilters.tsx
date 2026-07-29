import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import type { PerModelPredictionFilter } from '../../domain/compare.js'

export function ComparePredictionFilters({
  aboveRates,
  datasets,
  filters,
  onDatasetChange,
  onFiltersChange,
  onSubsetChange,
  onThresholdChange,
  reportLabels,
  reportNames,
  selectedDataset,
  selectedSubset,
  subsets,
  threshold,
}: {
  readonly aboveRates: Readonly<Record<string, number>>
  readonly datasets: readonly string[]
  readonly filters: Readonly<Record<string, PerModelPredictionFilter>>
  readonly onDatasetChange: (value: string) => void
  readonly onFiltersChange: (value: Record<string, PerModelPredictionFilter>) => void
  readonly onSubsetChange: (value: string) => void
  readonly onThresholdChange: (value: number) => void
  readonly reportLabels: Readonly<Record<string, string>>
  readonly reportNames: readonly string[]
  readonly selectedDataset: string
  readonly selectedSubset: string
  readonly subsets: readonly string[]
  readonly threshold: number
}) {
  const { t } = useTranslation()
  const preset = (mode: PerModelPredictionFilter) =>
    onFiltersChange(Object.fromEntries(reportNames.map((name) => [name, mode])))
  return (
    <div className="space-y-4 rounded-[6px] border border-border bg-surface/72 p-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_12rem]">
        <Field label={t('evaluations.compare.selectDataset')}>
          <SelectInput
            aria-label={t('evaluations.compare.selectDataset')}
            onValueChange={onDatasetChange}
            options={datasets.map((value) => ({ label: value, value }))}
            value={selectedDataset}
          />
        </Field>
        <Field label={t('evaluations.compare.selectSubset')}>
          <SelectInput
            aria-label={t('evaluations.compare.selectSubset')}
            onValueChange={onSubsetChange}
            options={subsets.map((value) => ({ label: value, value }))}
            value={selectedSubset}
          />
        </Field>
        <Field label={t('evaluations.compare.scoreThreshold')}>
          <TextInput
            max={1000000}
            min={-1000000}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) onThresholdChange(value)
            }}
            step="0.01"
            type="number"
            value={threshold}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => preset('any')} size="sm" variant="outline">
          {t('evaluations.compare.allAny')}
        </Button>
        <Button onClick={() => preset('above')} size="sm" variant="outline">
          {t('evaluations.compare.allAbove')}
        </Button>
        <Button onClick={() => preset('below')} size="sm" variant="outline">
          {t('evaluations.compare.allBelow')}
        </Button>
      </div>
      <div className="divide-y divide-border border-border border-y">
        {reportNames.map((name) => (
          <div className="flex flex-wrap items-center gap-3 py-3" key={name}>
            <div className="min-w-48 flex-1">
              <strong className="block truncate text-sm">{reportLabels[name] ?? name}</strong>
              <span className="font-mono text-muted-foreground text-xs">
                {aboveRates[name] === undefined ? '—' : `${Math.round(aboveRates[name] * 100)}%`}{' '}
                {t('evaluations.compare.aboveRate')}
              </span>
            </div>
            <div className="flex gap-1">
              {(['any', 'above', 'below'] as const).map((mode) => (
                <Button
                  aria-pressed={(filters[name] ?? 'any') === mode}
                  key={mode}
                  onClick={() => onFiltersChange({ ...filters, [name]: mode })}
                  size="sm"
                  variant={(filters[name] ?? 'any') === mode ? 'default' : 'ghost'}
                >
                  {t(`evaluations.prediction.${mode}`)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
