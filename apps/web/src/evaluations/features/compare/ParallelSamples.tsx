import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import type { AlignedPrediction } from '../../domain/compare.js'
import { formatMetricValue } from '../../domain/metric.js'
import { ChatView } from '../sample/ChatView.js'

export function ParallelSamples({
  errors,
  labels,
  reportNames,
  row,
  threshold,
}: {
  readonly errors: Readonly<Record<string, string>>
  readonly labels: Readonly<Record<string, string>>
  readonly reportNames: readonly string[]
  readonly row: AlignedPrediction | undefined
  readonly threshold: number
}) {
  const { t } = useTranslation()
  const baseline = reportNames[0] ? row?.models[reportNames[0]]?.NScore : undefined
  return (
    <div
      className="grid min-w-[48rem] gap-3"
      style={{ gridTemplateColumns: `repeat(${reportNames.length}, minmax(0, 1fr))` }}
    >
      {reportNames.map((name) => {
        const prediction = row?.models[name]
        const delta = prediction && baseline !== undefined ? prediction.NScore - baseline : null
        return (
          <section
            className="min-w-0 overflow-hidden rounded-[6px] border border-border bg-surface/70"
            key={name}
          >
            <header className="border-border border-b bg-surface-soft px-4 py-3">
              <strong className="block truncate text-sm">{labels[name] ?? name}</strong>
              <span className="mt-1 block font-mono text-muted-foreground text-xs">
                {prediction
                  ? `${formatMetricValue('score', prediction.NScore).primary} · Δ ${delta === null ? '—' : delta.toFixed(4)}`
                  : '—'}
              </span>
            </header>
            <div className="p-3">
              {errors[name] ? (
                <Alert role="alert">{errors[name]}</Alert>
              ) : prediction ? (
                <ChatView prediction={prediction} threshold={threshold} />
              ) : (
                <Alert role="status">{t('evaluations.compare.noAlignedSample')}</Alert>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
