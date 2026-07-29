import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Activity, BarChart3, BookOpen, FileText, FlaskConical, Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { cn } from '@/lib/utils.js'
import { EvaluationCapabilityBoundary } from '../components/EvaluationCapabilityBoundary.js'
import { registerEvaluationTranslations } from '../i18n/register.js'
import '../styles/tokens.css'

registerEvaluationTranslations()

const navigation = [
  { to: '/evaluations', key: 'dashboard', icon: BarChart3, exact: true },
  { to: '/evaluations/reports', key: 'reports', icon: FileText, exact: false },
  { to: '/evaluations/performance', key: 'performance', icon: Gauge, exact: false },
  { to: '/evaluations/tasks', key: 'tasks', icon: FlaskConical, exact: false },
  { to: '/evaluations/benchmarks', key: 'benchmarks', icon: BookOpen, exact: false },
] as const

export function EvaluationLayout() {
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <section className="evaluation-surface" data-evaluation-route={pathname}>
      <header className="flex flex-wrap items-end justify-between gap-5 border-border border-b pb-5">
        <div>
          <p className="font-mono text-primary text-xs uppercase tracking-[0.18em]">
            {t('evaluations.foundation.eyebrow')}
          </p>
          <h1 className="mt-2 font-semibold text-2xl tracking-tight">
            {t('evaluations.foundation.workspace')}
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
            {t('evaluations.foundation.workspaceDescription')}
          </p>
        </div>
        <Badge className="gap-2" tone="muted">
          <Activity aria-hidden="true" size={13} />
          {t('evaluations.foundation.managedService')}
        </Badge>
      </header>

      <nav
        aria-label={t('evaluations.foundation.navigation')}
        className="evaluation-subnav -mx-2 flex min-h-14 items-stretch gap-1 overflow-x-auto border-border border-b px-2"
      >
        {navigation.map((item) => {
          const Icon = item.icon
          return (
            <Link
              activeOptions={{ exact: item.exact }}
              activeProps={{ className: 'evaluation-subnav-active' }}
              className={cn(
                'relative flex min-h-11 shrink-0 items-center gap-2 px-3 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground',
                'after:absolute after:right-2 after:bottom-0 after:left-2 after:h-px after:origin-center after:scale-x-0 after:bg-primary after:transition-transform',
              )}
              key={item.to}
              to={item.to}
            >
              <Icon aria-hidden="true" size={15} />
              {t(
                item.key === 'reports'
                  ? 'evaluations.reports.title'
                  : `evaluations.nav.${item.key}`,
              )}
            </Link>
          )
        })}
      </nav>

      <div className="pt-7">
        <EvaluationCapabilityBoundary>
          <Outlet />
        </EvaluationCapabilityBoundary>
      </div>
    </section>
  )
}
