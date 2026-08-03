import { Link } from '@tanstack/react-router'
import { List, PanelLeftClose, PanelLeftOpen, Upload, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'
import type { DatasetNavigationSection } from './dataset-navigation.js'

const navigation = [
  { icon: List, key: 'datasetList', section: 'datasets', to: '/datasets' },
  { icon: Upload, key: 'ingest', section: 'ingest', to: '/ingest' },
  { icon: Workflow, key: 'transforms', section: 'transforms', to: '/transforms' },
] as const

export function DatasetSidebar({
  activeSection,
  collapsed,
  onCollapsedChange,
}: {
  activeSection: DatasetNavigationSection
  collapsed: boolean
  onCollapsedChange(collapsed: boolean): void
}) {
  const { t } = useTranslation()
  const toggleLabel = collapsed
    ? t('nav.expandDatasetNavigation')
    : t('nav.collapseDatasetNavigation')

  return (
    <aside className="sticky top-16 min-h-[calc(100dvh-4rem)] self-start border-border border-r bg-chrome/45 px-3 py-6 max-lg:static max-lg:min-h-0 max-lg:border-r-0 max-lg:border-b max-lg:bg-transparent max-lg:px-0 max-lg:py-0">
      <button
        aria-controls="dataset-workspace-navigation"
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        className="absolute top-5 -right-3.5 z-20 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary max-lg:hidden"
        onClick={() => onCollapsedChange(!collapsed)}
        title={toggleLabel}
        type="button"
      >
        {collapsed ? (
          <PanelLeftOpen aria-hidden="true" size={14} />
        ) : (
          <PanelLeftClose aria-hidden="true" size={14} />
        )}
      </button>
      <nav
        aria-label={t('nav.datasetNavigation')}
        className="flex flex-col gap-1 max-lg:-mx-2 max-lg:h-14 max-lg:flex-row max-lg:items-stretch max-lg:gap-1 max-lg:overflow-x-auto max-lg:px-2"
        id="dataset-workspace-navigation"
      >
        {navigation.map((item) => {
          const active = item.section === activeSection
          const Icon = item.icon
          const label = t(`nav.${item.key}`)

          return (
            <Link
              aria-current={active ? 'page' : undefined}
              aria-label={collapsed ? label : undefined}
              className={cn(
                'relative flex min-h-10 shrink-0 items-center gap-3 rounded-[4px] px-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-surface-hover/65 hover:text-foreground',
                collapsed && 'justify-center px-0',
                active && 'bg-accent/72 text-accent-foreground',
                'max-lg:h-full max-lg:justify-start max-lg:rounded-none max-lg:bg-transparent max-lg:px-4 max-lg:hover:bg-transparent',
                active && 'max-lg:text-foreground',
              )}
              key={item.section}
              title={collapsed ? label : undefined}
              to={item.to}
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 bottom-2 left-0 w-0.5 bg-primary max-lg:top-auto max-lg:right-2 max-lg:bottom-0 max-lg:left-2 max-lg:h-0.5 max-lg:w-auto"
                />
              ) : null}
              <Icon aria-hidden="true" className="shrink-0" size={16} />
              <span className={cn(collapsed && 'lg:sr-only')}>{label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
