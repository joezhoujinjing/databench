import { useTranslation } from 'react-i18next'
import { evalScopeClient } from '../../api/client.js'
import type { PerfDetailResponse } from '../../api/schemas.js'
import { GeneratedChartPanel } from '../../components/charts/GeneratedChartPanel.js'
import {
  applicableLatencyCharts,
  PERFORMANCE_THROUGHPUT_CHARTS,
} from '../../domain/performance/view.js'

export function PerformanceCharts({ detail }: { readonly detail: PerfDetailResponse }) {
  const { t } = useTranslation()
  const fallback = { columns: detail.summary_columns, rows: detail.summary_rows }
  const groups = [
    { charts: applicableLatencyCharts(detail), title: t('evaluations.performance.latencyGroup') },
    { charts: PERFORMANCE_THROUGHPUT_CHARTS, title: t('evaluations.performance.throughputGroup') },
  ]
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section className="space-y-3" key={group.title}>
          <h2 className="font-semibold text-lg">{group.title}</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {group.charts.map((chart) => (
              <GeneratedChartPanel
                fallback={fallback}
                key={chart}
                load={(signal) =>
                  evalScopeClient.request('perfChart', {
                    query: { chart_type: chart, path: detail.path, theme: 'dark' },
                    signal,
                  })
                }
                queryKey={['evalscope', 'performance', detail.path, 'chart', chart]}
                title={t(`evaluations.performance.chart_${chart}`, { defaultValue: chart })}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
