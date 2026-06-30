import { Link, Outlet } from '@tanstack/react-router'
import { Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FEATURES, useModuleEnabled } from '@/api/capabilities.js'
import { CapabilityGate } from '@/components/shell/CapabilityGate.js'
import { ConnectionPanel } from '@/components/shell/ConnectionPanel.js'
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher.js'
import { cn } from '@/lib/utils.js'

export function RootLayout() {
  const { t } = useTranslation()
  const lineageEnabled = useModuleEnabled(FEATURES.lineage)
  const recipesEnabled = useModuleEnabled(FEATURES.recipes)
  const transformsEnabled = useModuleEnabled(FEATURES.transforms)
  const vocabulariesEnabled = useModuleEnabled(FEATURES.vocabularies)

  return (
    <div className="min-h-dvh bg-background/95 text-foreground">
      <header className="sticky top-0 z-30 border-border border-b bg-background/88 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[100rem] items-center gap-8 px-6">
          <Link
            className="flex shrink-0 items-center gap-3 font-semibold text-[1.18rem]"
            to="/datasets"
          >
            <Layers3 aria-hidden="true" className="text-primary" size={24} strokeWidth={2.15} />
            <span>Databench</span>
          </Link>
          <nav className="flex h-full min-w-0 items-center gap-1 overflow-x-auto">
            <NavLink to="/datasets">{t('nav.datasets')}</NavLink>
            <NavLink to="/ingest">{t('nav.ingest')}</NavLink>
            {transformsEnabled ? <NavLink to="/transforms">{t('nav.transforms')}</NavLink> : null}
            {recipesEnabled ? <NavLink to="/recipe">{t('nav.recipe')}</NavLink> : null}
            {lineageEnabled ? <NavLink to="/lineage">{t('nav.lineage')}</NavLink> : null}
            {vocabulariesEnabled ? (
              <NavLink to="/vocabularies">{t('nav.vocabularies')}</NavLink>
            ) : null}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-4">
            <LanguageSwitcher />
            <ConnectionPanel />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[100rem] px-6 py-8">
        <CapabilityGate>
          <Outlet />
        </CapabilityGate>
      </main>
    </div>
  )
}

function NavLink({
  children,
  to,
}: {
  children: string
  to: '/datasets' | '/ingest' | '/transforms' | '/recipe' | '/lineage' | '/vocabularies'
}) {
  return (
    <Link
      activeProps={{
        className: 'text-foreground after:opacity-100',
      }}
      className={cn(
        'relative flex h-full items-center px-5 text-muted-foreground text-sm transition hover:text-foreground',
        'after:absolute after:right-3 after:bottom-0 after:left-3 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity',
      )}
      to={to}
    >
      <span>{children}</span>
    </Link>
  )
}
