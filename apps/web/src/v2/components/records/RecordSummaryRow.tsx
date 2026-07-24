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
      className="grid min-h-24 grid-cols-[minmax(13rem,1.3fr)_minmax(14rem,2fr)_minmax(12rem,1fr)] items-center gap-5 border-border border-b px-5 py-4 transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none max-md:grid-cols-1"
      params={{ recordId: record.record_id, ref: datasetVersion }}
      to="/v2/datasets/$ref/records/$recordId"
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
      <div className="flex flex-wrap gap-1.5">
        <EligibilityBadge label="SFT" value={record.eligibility.sft} />
        <EligibilityBadge label="DPO" value={record.eligibility.dpo} />
        <EligibilityBadge label="RLVR" value={record.eligibility.rlvr_grpo} />
      </div>
    </Link>
  )
}

function EligibilityBadge({
  label,
  value,
}: {
  label: string
  value: RecordSummaryV2['eligibility']['sft']
}) {
  const { t } = useTranslation()
  const status = value.eligible ? t('v2.record.eligible') : t('v2.record.ineligible')

  return (
    <span className="space-y-1">
      <Badge tone={value.eligible ? 'green' : 'muted'}>
        {label} · {status} · {value.output_count}
      </Badge>
      {value.reason_codes.length > 0 ? (
        <span className="block text-dim-foreground text-[0.68rem] leading-4">
          {value.reason_codes.join(', ')}
        </span>
      ) : null}
    </span>
  )
}
