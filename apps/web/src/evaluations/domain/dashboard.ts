import type { PerfRunSummary, ReportSummary } from '../api/schemas.js'

export const DASHBOARD_PAGE_SIZE = 15

export type DashboardRun =
  | { readonly kind: 'eval'; readonly timestamp: string; readonly report: ReportSummary }
  | { readonly kind: 'perf'; readonly timestamp: string; readonly run: PerfRunSummary }

export type DashboardKpis = {
  readonly evaluations: number
  readonly latest: string | null
  readonly models: number
  readonly performance: number
}

export function mergeDashboardRuns(
  reports: readonly ReportSummary[],
  performance: readonly PerfRunSummary[],
): DashboardRun[] {
  return [
    ...reports.map(
      (report): DashboardRun => ({ kind: 'eval', report, timestamp: report.timestamp ?? '' }),
    ),
    ...performance.map(
      (run): DashboardRun => ({ kind: 'perf', run, timestamp: run.timestamp ?? '' }),
    ),
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

export function summarizeDashboard(
  reports: readonly ReportSummary[],
  performance: readonly PerfRunSummary[],
): DashboardKpis {
  const models = new Set<string>()
  for (const report of reports) if (report.model_name.trim()) models.add(report.model_name.trim())
  for (const run of performance) if (run.model.trim()) models.add(run.model.trim())
  const latest = mergeDashboardRuns(reports, performance)[0]?.timestamp || null
  return {
    evaluations: reports.length,
    latest,
    models: models.size,
    performance: performance.length,
  }
}

export function filterDashboardRuns(
  runs: readonly DashboardRun[],
  type: 'all' | 'eval' | 'perf',
  search: string,
): DashboardRun[] {
  const query = search.trim().toLocaleLowerCase()
  return runs.filter((item) => {
    if (type !== 'all' && item.kind !== type) return false
    if (query === '') return true
    const values =
      item.kind === 'eval'
        ? [item.report.model_name, item.report.dataset_name]
        : [
            item.run.model,
            item.run.dataset,
            item.run.api_type,
            item.run.provider ?? '',
            item.run.protocol ?? '',
          ]
    return values.some((value) => value.toLocaleLowerCase().includes(query))
  })
}
