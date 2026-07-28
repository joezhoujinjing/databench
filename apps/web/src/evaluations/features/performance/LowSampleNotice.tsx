import { AlertTriangle, BadgeCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { classifyPerformanceSampleSize, type SampleTier } from '../../domain/performance/compare.js'

function worstTier(counts: readonly number[]): SampleTier {
  if (counts.some((count) => classifyPerformanceSampleSize(count) === 'critical')) return 'critical'
  if (counts.some((count) => classifyPerformanceSampleSize(count) === 'warning')) return 'warning'
  return 'normal'
}

export function LowSampleNotice({ counts }: { readonly counts: readonly number[] }) {
  const { t } = useTranslation()
  const tier = worstTier(counts)
  return (
    <div
      className={`flex items-start gap-2 rounded-[5px] border px-4 py-3 text-sm ${tier === 'critical' ? 'border-danger/35 bg-danger/7' : tier === 'warning' ? 'border-warning/35 bg-warning/7' : 'border-success/30 bg-success/6'}`}
      data-sample-tier={tier}
      role="status"
    >
      {tier === 'normal' ? (
        <BadgeCheck aria-hidden="true" className="mt-0.5 shrink-0 text-success" size={15} />
      ) : (
        <AlertTriangle
          aria-hidden="true"
          className={`mt-0.5 shrink-0 ${tier === 'critical' ? 'text-danger' : 'text-warning'}`}
          size={15}
        />
      )}
      <span>{t(`evaluations.performance.lowSample_${tier}`)}</span>
    </div>
  )
}
