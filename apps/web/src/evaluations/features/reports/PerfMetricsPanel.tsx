import { Activity, Clock, Gauge, Timer, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PerfMetrics } from '../../api/schemas.js'

function Stat({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly value: string
}) {
  return (
    <div className="min-w-0 border-border border-b px-4 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
      <p className="flex items-center gap-2 text-muted-foreground text-xs">
        {icon}
        {label}
      </p>
      <strong className="mt-2 block font-mono text-lg">{value}</strong>
    </div>
  )
}

export function PerfMetricsPanel({ metrics }: { readonly metrics: PerfMetrics }) {
  const { t } = useTranslation()
  const summary = metrics.summary
  const percentiles = ['mean', '50%', '90%', '99%', 'max'] as const
  return (
    <div className="space-y-4">
      <div className="grid rounded-[5px] border border-border sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          icon={<Clock aria-hidden="true" size={13} />}
          label={t('evaluations.reportDetail.avgLatency')}
          value={`${summary.latency.mean.toFixed(3)} s`}
        />
        <Stat
          icon={<Zap aria-hidden="true" size={13} />}
          label={t('evaluations.reportDetail.outputTps')}
          value={summary.throughput.avg_output_tps.toFixed(2)}
        />
        <Stat
          icon={<Activity aria-hidden="true" size={13} />}
          label="Requests/s"
          value={summary.throughput.avg_req_ps.toFixed(3)}
        />
        <Stat
          icon={<Gauge aria-hidden="true" size={13} />}
          label={t('evaluations.reportDetail.samples')}
          value={summary.n_samples.toLocaleString()}
        />
        <Stat
          icon={<Timer aria-hidden="true" size={13} />}
          label={t('evaluations.reportDetail.tokenTotal')}
          value={(
            summary.usage.total_tokens_count ?? summary.usage.total_tokens.mean
          ).toLocaleString()}
        />
      </div>
      <div className="overflow-x-auto rounded-[5px] border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-soft text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Metric</th>
              {percentiles.map((percentile) => (
                <th className="px-3 py-2 text-right" key={percentile}>
                  {percentile}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(
              [
                ['Latency', summary.latency],
                ...(summary.ttft ? [['TTFT', summary.ttft] as const] : []),
                ...(summary.tpot ? [['TPOT', summary.tpot] as const] : []),
              ] as const
            ).map(([label, values]) => (
              <tr key={label}>
                <td className="px-3 py-2">{label}</td>
                {percentiles.map((percentile) => (
                  <td className="px-3 py-2 text-right font-mono" key={percentile}>
                    {values[percentile]?.toFixed(3) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
