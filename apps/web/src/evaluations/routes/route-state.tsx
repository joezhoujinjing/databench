import type { ErrorComponentProps } from '@tanstack/react-router'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'

export function EvaluationRoutePending() {
  const { t } = useTranslation()
  return (
    <section
      aria-busy="true"
      aria-label={t('evaluations.foundation.loading')}
      className="space-y-5"
    >
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-full max-w-3xl" />
      <Skeleton className="h-36 w-full" />
    </section>
  )
}

export function EvaluationRouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation()
  return (
    <section className="border-danger/35 border-y py-10" role="alert">
      <p className="font-mono text-danger text-xs uppercase tracking-[0.18em]">
        {t('evaluations.foundation.routeErrorEyebrow')}
      </p>
      <h1 className="mt-2 font-semibold text-2xl">{t('evaluations.foundation.routeError')}</h1>
      <p className="mt-3 max-w-3xl text-muted-foreground text-sm leading-6">
        {error instanceof Error ? error.message : t('evaluations.foundation.unknownError')}
      </p>
      <Button className="mt-5" onClick={reset} variant="outline">
        <RotateCcw aria-hidden="true" size={15} />
        {t('evaluations.foundation.retry')}
      </Button>
    </section>
  )
}

export function EvaluationRouteNotFound() {
  const { t } = useTranslation()
  return (
    <section className="border-border border-y py-10">
      <p className="font-mono text-primary text-xs uppercase tracking-[0.18em]">404</p>
      <h1 className="mt-2 font-semibold text-2xl">{t('evaluations.foundation.notFound')}</h1>
      <p className="mt-3 text-muted-foreground text-sm leading-6">
        {t('evaluations.foundation.notFoundDescription')}
      </p>
    </section>
  )
}
