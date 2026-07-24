import { Link, Outlet } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils.js'
import { PostTrainingV2Gate } from '../components/PostTrainingV2Gate.js'

export function V2Layout() {
  const { t } = useTranslation()
  return (
    <PostTrainingV2Gate>
      <nav
        aria-label={t('v2.nav.label')}
        className="mb-6 flex flex-wrap gap-1 border-border border-b"
      >
        <V2NavLink label={t('v2.nav.datasets')} to="/v2/datasets" />
        <V2NavLink label={t('v2.nav.ingest')} to="/v2/ingest" />
        <V2NavLink label={t('v2.nav.transforms')} to="/v2/transforms" />
      </nav>
      <Outlet />
    </PostTrainingV2Gate>
  )
}

function V2NavLink({
  label,
  to,
}: {
  label: string
  to: '/v2/datasets' | '/v2/ingest' | '/v2/transforms'
}) {
  return (
    <Link
      activeProps={{ className: 'border-primary text-foreground' }}
      className={cn(
        '-mb-px border-transparent border-b-2 px-4 py-3 text-muted-foreground text-sm hover:text-foreground',
      )}
      to={to}
    >
      {label}
    </Link>
  )
}
