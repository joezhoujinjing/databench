import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Database } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionPanel } from '@/components/shell/ConnectionPanel.js'
import { DatasetSidebar } from '@/components/shell/DatasetSidebar.js'
import { datasetNavigationSection } from '@/components/shell/dataset-navigation.js'
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher.js'
import { cn } from '@/lib/utils.js'
import { PostTrainingV2Gate } from '@/v2/components/PostTrainingV2Gate.js'

export function RootLayout() {
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const datasetSection = datasetNavigationSection(pathname)
  const isEvaluationWorkspace = pathname.startsWith('/evaluations')
  const [isDatasetSidebarCollapsed, setIsDatasetSidebarCollapsed] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    void pathname
    mainRef.current?.focus()
  }, [pathname])

  return (
    <div className="min-h-dvh bg-background/95 text-foreground">
      <header className="sticky top-0 z-30 border-border border-b bg-chrome/94 backdrop-blur-xl">
        <div className="mx-auto grid min-h-16 max-w-[120rem] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-6 px-8 max-md:gap-x-3 max-md:px-4">
          <Link
            aria-label="Databench"
            className="flex shrink-0 items-center gap-3 font-semibold text-[1.35rem]"
            to="/datasets"
          >
            <Database aria-hidden="true" className="text-primary" size={24} strokeWidth={2.15} />
            <span className="max-sm:sr-only">Databench</span>
          </Link>
          <nav
            aria-label={t('nav.primary')}
            className="flex h-16 min-w-0 items-center justify-center gap-5 overflow-x-auto max-md:order-3 max-md:col-span-3 max-md:h-12 max-md:justify-start"
          >
            <PrimaryNavLink active={datasetSection !== null} to="/datasets">
              {t('nav.datasets')}
            </PrimaryNavLink>
            <PrimaryNavLink active={pathname.startsWith('/training')} to="/training">
              {t('nav.training')}
            </PrimaryNavLink>
            <PrimaryNavLink active={pathname.startsWith('/evaluations')} to="/evaluations">
              {t('nav.evaluations')}
            </PrimaryNavLink>
          </nav>
          <div className="flex shrink-0 items-center gap-3 border-border border-l pl-5 max-md:pl-3">
            <LanguageSwitcher />
            <ConnectionPanel />
          </div>
        </div>
      </header>
      <main
        className={cn(
          'mx-auto max-w-[120rem] outline-none',
          datasetSection !== null &&
            cn(
              'grid min-h-[calc(100dvh-4rem)] max-lg:block',
              isDatasetSidebarCollapsed
                ? 'grid-cols-[3.25rem_minmax(0,1fr)]'
                : 'grid-cols-[11.5rem_minmax(0,1fr)]',
            ),
          datasetSection === null && !isEvaluationWorkspace && 'px-8 py-10 max-md:px-4 max-md:py-7',
        )}
        ref={mainRef}
        tabIndex={-1}
      >
        {datasetSection === null ? (
          <PostTrainingV2Gate>
            <Outlet />
          </PostTrainingV2Gate>
        ) : (
          <>
            <DatasetSidebar
              activeSection={datasetSection}
              collapsed={isDatasetSidebarCollapsed}
              onCollapsedChange={setIsDatasetSidebarCollapsed}
            />
            <div className="min-w-0 px-8 py-6 max-md:px-4 max-md:py-6">
              <PostTrainingV2Gate>
                <Outlet />
              </PostTrainingV2Gate>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function PrimaryNavLink({
  active,
  children,
  to,
}: {
  active: boolean
  children: string
  to: '/datasets' | '/evaluations' | '/training'
}) {
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-full shrink-0 items-center px-4 font-medium text-base text-muted-foreground transition-colors hover:text-foreground',
        'after:absolute after:right-2 after:bottom-0 after:left-2 after:h-0.5 after:origin-center after:scale-x-0 after:bg-primary after:transition-transform',
        active && 'text-foreground after:scale-x-100',
      )}
      to={to}
    >
      <span>{children}</span>
    </Link>
  )
}
