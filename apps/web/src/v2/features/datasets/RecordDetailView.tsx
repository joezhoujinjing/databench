import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { PageHeader, PageShell } from '@/components/ui/surface.js'
import type { RecordViewV2 } from '../../api/types.js'
import { RecordView } from '../../components/records/RecordView.js'

export function V2RecordDetailView({ view }: { view: RecordViewV2 }) {
  const { t } = useTranslation()

  return (
    <PageShell>
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link params={{ ref: view.dataset_version }} to="/v2/datasets/$ref">
              {t('v2.record.back')}
            </Link>
          </Button>
        }
        description={t('v2.record.description')}
        eyebrow="V2 / record"
        title={view.record.id}
      />
      <RecordView view={view} />
    </PageShell>
  )
}
