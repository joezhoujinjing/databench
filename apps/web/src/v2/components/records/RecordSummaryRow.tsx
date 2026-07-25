import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { ellipsizeMiddle, formatInteger } from '@/lib/format.js'
import type { RecordSummaryV2 } from '../../api/types.js'

export function RecordSummaryRow({
  datasetVersion,
  record,
}: {
  datasetVersion: string
  record: RecordSummaryV2
}) {
  const { t } = useTranslation()

  return (
    <Link
      className="grid min-h-24 grid-cols-[minmax(13rem,1.3fr)_minmax(14rem,2fr)] items-center gap-5 border-border border-b px-5 py-4 transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none max-md:grid-cols-1"
      params={{ recordId: record.record_id, ref: datasetVersion }}
      to="/datasets/$ref/records/$recordId"
    >
      <div className="min-w-0">
        <div className="font-mono text-sm" title={record.record_id}>
          {ellipsizeMiddle(record.record_id, 12)}
        </div>
        <div className="mt-1 font-mono text-dim-foreground text-xs" title={record.record_digest}>
          {ellipsizeMiddle(record.record_digest, 10)}
        </div>
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 whitespace-pre-wrap text-sm leading-6">
          {record.preview ?? t('v2.records.noPreview')}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {record.lang ? <Badge tone="muted">{record.lang}</Badge> : null}
          <Badge tone="muted">
            {t('v2.records.candidates', { count: formatInteger(record.candidate_count) })}
          </Badge>
          <Badge tone="muted">
            {t('v2.records.signals', { count: formatInteger(record.signal_count) })}
          </Badge>
        </div>
      </div>
    </Link>
  )
}
