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
    <section
      className="evaluation-surface grid min-h-[calc(100dvh-5rem)] grid-cols-[13.5rem_minmax(0,1fr)] gap-x-8 px-8 max-lg:block max-md:px-4"
      data-evaluation-route={pathname}
    >
      <aside className="sticky top-20 min-h-[calc(100dvh-5rem)] self-start border-border border-r py-10 pr-7 max-lg:static max-lg:min-h-0 max-lg:border-r-0 max-lg:border-b max-lg:py-0 max-lg:pr-0">
        <p className="mb-7 px-3 font-semibold text-base tracking-tight max-lg:sr-only">
          {t('nav.evaluations')}
        </p>
        <nav
          aria-label={t('evaluations.foundation.navigation')}
          className="flex flex-col gap-1 max-lg:-mx-2 max-lg:h-14 max-lg:flex-row max-lg:items-stretch max-lg:gap-1 max-lg:overflow-x-auto max-lg:px-2"
        >
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <Link
                activeOptions={{ exact: item.exact, includeSearch: false }}
                activeProps={{ className: 'evaluation-sidebar-active' }}
                className={cn(
                  'relative flex min-h-11 shrink-0 items-center gap-2 rounded-[4px] px-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-surface-hover hover:text-foreground',
                  'before:absolute before:top-2 before:bottom-2 before:left-0 before:w-0.5 before:origin-center before:scale-y-0 before:bg-primary before:transition-transform',
                  'max-lg:h-full max-lg:rounded-none max-lg:bg-transparent max-lg:px-4 max-lg:hover:bg-transparent',
                  'max-lg:before:top-auto max-lg:before:right-2 max-lg:before:bottom-0 max-lg:before:left-2 max-lg:before:h-0.5 max-lg:before:w-auto max-lg:before:origin-center max-lg:before:scale-x-0 max-lg:before:scale-y-100',
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
      </aside>

      <div className="min-w-0 py-10 max-md:py-7">
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

        <div className="pt-7">
          <EvaluationCapabilityBoundary>
            <Outlet />
          </EvaluationCapabilityBoundary>
        </div>
      </div>
    </section>
  )
}
