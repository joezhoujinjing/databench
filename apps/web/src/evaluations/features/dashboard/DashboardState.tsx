import { Link } from '@tanstack/react-router'
import { FileText, SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Surface } from '@/components/ui/surface.js'

export function DashboardPartialState({ errors }: { readonly errors: readonly string[] }) {
  const { t } = useTranslation()
  if (errors.length === 0) return null
  return (
    <Alert className="border-warning/35" role="status">
      <strong>{t('evaluations.dashboard.partialTitle')}</strong>
      <span className="ml-2 text-muted-foreground">{errors.join(' · ')}</span>
    </Alert>
  )
}

export function DashboardEmptyState({ filtered }: { readonly filtered: boolean }) {
  const { t } = useTranslation()
  return (
    <Surface className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      {filtered ? (
        <SearchX aria-hidden="true" className="text-muted-foreground" size={26} />
      ) : (
        <FileText aria-hidden="true" className="text-primary" size={26} />
      )}
      <h2 className="mt-4 font-semibold text-lg">
        {t(filtered ? 'evaluations.dashboard.noMatch' : 'evaluations.dashboard.welcomeTitle')}
      </h2>
      <p className="mt-2 max-w-xl text-muted-foreground text-sm leading-6">
        {t(filtered ? 'evaluations.dashboard.noMatchHint' : 'evaluations.dashboard.welcomeDesc')}
      </p>
      {!filtered ? (
        <Button asChild className="mt-5" size="sm">
          <Link to="/evaluations/tasks">{t('evaluations.tasks.title')}</Link>
        </Button>
      ) : null}
    </Surface>
  )
}
