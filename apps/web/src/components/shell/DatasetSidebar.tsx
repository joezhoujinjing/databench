import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'
import type { DatasetNavigationSection } from './dataset-navigation.js'

const navigation = [
  { key: 'datasetList', section: 'datasets', to: '/datasets' },
  { key: 'ingest', section: 'ingest', to: '/ingest' },
  { key: 'transforms', section: 'transforms', to: '/transforms' },
] as const

export function DatasetSidebar({ activeSection }: { activeSection: DatasetNavigationSection }) {
  const { t } = useTranslation()

  return (
    <aside className="sticky top-20 min-h-[calc(100dvh-5rem)] self-start border-border border-r py-10 pr-7 max-lg:static max-lg:min-h-0 max-lg:border-r-0 max-lg:border-b max-lg:py-0 max-lg:pr-0">
      <p className="mb-7 px-3 font-semibold text-base tracking-tight max-lg:sr-only">
        {t('nav.datasets')}
      </p>
      <nav
        aria-label={t('nav.datasetNavigation')}
        className="flex flex-col gap-1 max-lg:-mx-2 max-lg:h-14 max-lg:flex-row max-lg:items-stretch max-lg:gap-1 max-lg:overflow-x-auto max-lg:px-2"
      >
        {navigation.map((item) => {
          const active = item.section === activeSection

          return (
            <Link
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex min-h-11 shrink-0 items-center rounded-[4px] px-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-surface-hover hover:text-foreground',
                active && 'bg-accent/72 text-accent-foreground',
                'max-lg:h-full max-lg:rounded-none max-lg:bg-transparent max-lg:px-4 max-lg:hover:bg-transparent',
                active && 'max-lg:text-foreground',
              )}
              key={item.section}
              to={item.to}
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 bottom-2 left-0 w-0.5 bg-primary max-lg:top-auto max-lg:right-2 max-lg:bottom-0 max-lg:left-2 max-lg:h-0.5 max-lg:w-auto"
                />
              ) : null}
              {t(`nav.${item.key}`)}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
