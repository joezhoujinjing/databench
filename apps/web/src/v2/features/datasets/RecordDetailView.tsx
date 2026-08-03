import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PageShell } from '@/components/ui/surface.js'
import type { RecordViewV2 } from '../../api/types.js'
import { RecordView } from '../../components/records/RecordView.js'

export function V2RecordDetailView({ view }: { view: RecordViewV2 }) {
  const { t } = useTranslation()

  return (
    <PageShell className="space-y-4">
      <header className="space-y-3">
        <Link
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          params={{ ref: view.dataset_version }}
          to="/datasets/$ref"
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {t('v2.record.back')}
        </Link>
        <h1 className="font-semibold text-[1.75rem] leading-tight tracking-tight">
          {t('v2.record.detailTitle')}
        </h1>
      </header>
      <RecordView view={view} />
    </PageShell>
  )
}
