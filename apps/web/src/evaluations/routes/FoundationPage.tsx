import { ArrowRight, Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'

export type EvaluationFoundationPageName =
  | 'benchmarks'
  | 'compare'
  | 'dashboard'
  | 'performance'
  | 'performanceCompare'
  | 'performanceDetail'
  | 'reportDetail'
  | 'reports'
  | 'tasks'
  | 'viewer'

export function EvaluationFoundationPage({ name }: { name: EvaluationFoundationPageName }) {
  const { t } = useTranslation()
  const titleId = `evaluation-${name}-title`

  return (
    <section aria-labelledby={titleId} data-capability-state="planned">
      <div className="grid gap-8 border-border border-y py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="muted">{t('evaluations.foundation.foundationPhase')}</Badge>
            <span className="font-mono text-dim-foreground text-xs">
              /evaluations/{name === 'dashboard' ? '' : name}
            </span>
          </div>
          <h2 className="mt-4 font-semibold text-3xl tracking-tight" id={titleId}>
            {t(`evaluations.foundation.pages.${name}`)}
          </h2>
          <p className="mt-3 max-w-3xl text-muted-foreground leading-7">
            {t('evaluations.foundation.notMigratedDescription')}
          </p>
        </div>
        <div className="border-border border-l pl-5 max-md:border-l-0 max-md:border-t max-md:pt-5 max-md:pl-0">
          <p className="flex items-center gap-2 font-medium text-sm">
            <Construction aria-hidden="true" className="text-primary" size={16} />
            {t('evaluations.foundation.notMigrated')}
          </p>
          <p className="mt-2 text-muted-foreground text-sm leading-6">
            {t('evaluations.foundation.foundationOnly')}
          </p>
          <p className="mt-4 flex items-center gap-2 font-mono text-dim-foreground text-xs">
            <ArrowRight aria-hidden="true" size={13} />
            {t('evaluations.foundation.nextStep')}
          </p>
        </div>
      </div>
    </section>
  )
}
