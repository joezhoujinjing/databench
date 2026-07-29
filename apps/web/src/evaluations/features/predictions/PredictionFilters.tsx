import { ArrowDown, ArrowUp, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PredictionMode } from '../../domain/reports.js'

export function PredictionFilters({
  counts,
  mode,
  onModeChange,
  onSubsetChange,
  onThresholdChange,
  subset,
  subsets,
  threshold,
}: {
  readonly counts: { readonly above: number; readonly all: number; readonly below: number }
  readonly mode: PredictionMode
  readonly onModeChange: (mode: PredictionMode) => void
  readonly onSubsetChange: (subset: string) => void
  readonly onThresholdChange: (threshold: number) => void
  readonly subset: string
  readonly subsets: readonly string[]
  readonly threshold: number
}) {
  const { t } = useTranslation()
  const items = [
    { count: counts.all, Icon: List, label: t('evaluations.common.all'), value: 'all' },
    {
      count: counts.above,
      Icon: ArrowUp,
      label: t('evaluations.prediction.aboveFilter'),
      value: 'above',
    },
    {
      count: counts.below,
      Icon: ArrowDown,
      label: t('evaluations.prediction.belowFilter'),
      value: 'below',
    },
  ] as const
  return (
    <div className="space-y-4 border-border border-b pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="grid min-w-52 gap-2 text-muted-foreground text-sm">
          {t('evaluations.reportDetail.selectSubset')}
          <select
            className="h-10 rounded-[4px] border border-border bg-background/45 px-3 text-foreground outline-none focus:border-primary"
            onChange={(event) => onSubsetChange(event.target.value)}
            value={subset}
          >
            {subsets.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label
          className="grid w-32 gap-2 text-muted-foreground text-sm"
          title={t('evaluations.prediction.thresholdHint')}
        >
          {t('evaluations.single.scoreThreshold')}
          <input
            className="h-10 rounded-[4px] border border-border bg-background/45 px-3 text-foreground outline-none focus:border-primary"
            max={1}
            min={0}
            onChange={(event) => onThresholdChange(Number(event.target.value))}
            step="0.01"
            type="number"
            value={threshold}
          />
        </label>
      </div>
      <fieldset className="inline-flex max-w-full overflow-x-auto rounded-[5px] border border-border">
        <legend className="sr-only">{t('evaluations.prediction.thresholdViews')}</legend>
        {items.map(({ count, Icon, label, value }) => (
          <button
            aria-pressed={mode === value}
            className={`flex min-h-10 items-center gap-2 border-border border-r px-4 text-sm last:border-r-0 ${mode === value ? 'bg-primary text-primary-foreground' : 'bg-background/35 text-muted-foreground hover:text-foreground'}`}
            key={value}
            onClick={() => onModeChange(value)}
            type="button"
          >
            <Icon aria-hidden="true" size={13} />
            {label}
            <span className="font-mono text-xs opacity-75">{count}</span>
          </button>
        ))}
      </fieldset>
    </div>
  )
}
