import { useTranslation } from 'react-i18next'
import { evalScopeClient } from '../../api/client.js'
import { GeneratedChartPanel } from '../../components/charts/GeneratedChartPanel.js'
import type { PerformanceCompareModel } from '../../domain/performance/compare.js'
import {
  PERFORMANCE_LATENCY_CHARTS,
  PERFORMANCE_THROUGHPUT_CHARTS,
} from '../../domain/performance/view.js'

export function PerformanceCompareCharts({
  embedding,
  model,
  paths,
}: {
  readonly embedding: boolean
  readonly model: PerformanceCompareModel
  readonly paths: readonly string[]
}) {
  const { t } = useTranslation()
  const fallback = {
    columns: ['Metric', 'Baseline', 'Candidate', 'Absolute delta', 'Percent delta'],
    rows: model.deltas.map((delta) => [
      delta.key,
      delta.baseline,
      delta.candidate,
      delta.absolute,
      delta.percent,
    ]),
  }
  const groups = [
    {
      charts: embedding ? ['latency'] : PERFORMANCE_LATENCY_CHARTS,
      title: t('evaluations.performance.latencyGroup'),
    },
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
                  evalScopeClient.request('perfCompareChart', {
                    query: { chart_type: chart, paths: paths.join(';'), theme: 'dark' },
                    signal,
                  })
                }
                queryKey={['evalscope', 'performance', 'compare-chart', paths.join(';'), chart]}
                title={t(`evaluations.performance.chart_${chart}`, { defaultValue: chart })}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
