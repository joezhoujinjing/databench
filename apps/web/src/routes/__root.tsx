import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Database } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionPanel } from '@/components/shell/ConnectionPanel.js'
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher.js'
import { cn } from '@/lib/utils.js'
import { PostTrainingV2Gate } from '@/v2/components/PostTrainingV2Gate.js'

export function RootLayout() {
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    void pathname
    mainRef.current?.focus()
  }, [pathname])

  return (
    <div className="min-h-dvh bg-background/95 text-foreground">
      <header className="sticky top-0 z-30 border-border border-b bg-background/88 backdrop-blur-xl">
        <div className="mx-auto grid min-h-20 max-w-[120rem] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-6 px-8 max-md:gap-x-3 max-md:px-4">
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
            className="flex h-20 min-w-0 items-center justify-center gap-5 overflow-x-auto max-md:order-3 max-md:col-span-3 max-md:h-12 max-md:justify-start"
          >
            <NavLink to="/datasets">{t('nav.datasets')}</NavLink>
            <NavLink to="/ingest">{t('nav.ingest')}</NavLink>
            <NavLink to="/transforms">{t('nav.transforms')}</NavLink>
          </nav>
          <div className="flex shrink-0 items-center gap-3 border-border border-l pl-5 max-md:pl-3">
            <LanguageSwitcher />
            <ConnectionPanel />
          </div>
        </div>
      </header>
      <main
        className="mx-auto max-w-[120rem] px-8 py-10 outline-none max-md:px-4 max-md:py-7"
        ref={mainRef}
        tabIndex={-1}
      >
        <PostTrainingV2Gate>
          <Outlet />
        </PostTrainingV2Gate>
      </main>
    </div>
  )
}

function NavLink({
  children,
  to,
}: {
  children: string
  to: '/datasets' | '/ingest' | '/transforms'
}) {
  return (
    <Link
      activeOptions={{ exact: to !== '/datasets' }}
      activeProps={{
        className: 'text-foreground after:scale-x-100',
      }}
      className={cn(
        'relative flex h-full shrink-0 items-center px-4 font-medium text-base text-muted-foreground transition-colors hover:text-foreground',
        'after:absolute after:right-2 after:bottom-0 after:left-2 after:h-0.5 after:origin-center after:scale-x-0 after:bg-primary after:transition-transform',
      )}
      to={to}
    >
      <span>{children}</span>
    </Link>
  )
}
