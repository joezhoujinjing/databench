import type { PerfDetailResponse } from '../../api/schemas.js'

export type PerformanceDetailTab = 'charts' | 'overview' | 'runs'

export const PERFORMANCE_LATENCY_CHARTS = ['latency', 'ttft', 'tpot'] as const
export const PERFORMANCE_THROUGHPUT_CHARTS = ['rps', 'throughput', 'success'] as const

export function isEmbeddingPerformance(
  detail: Pick<PerfDetailResponse, 'api_type' | 'is_embedding'>,
): boolean {
  return detail.is_embedding || /(?:embedding|rerank)/iu.test(detail.api_type)
}

export function performanceDetailTabs(
  detail: Pick<PerfDetailResponse, 'num_runs'>,
): PerformanceDetailTab[] {
  return detail.num_runs <= 1 ? ['overview', 'runs'] : ['overview', 'charts', 'runs']
}

export function defaultPerformanceDetailTab(
  detail: Pick<PerfDetailResponse, 'num_runs'>,
): PerformanceDetailTab {
  return detail.num_runs <= 1 ? 'runs' : 'overview'
}

export function normalizePerformanceDetailTab(
  detail: Pick<PerfDetailResponse, 'num_runs'>,
  requested: PerformanceDetailTab,
): PerformanceDetailTab {
  const tabs = performanceDetailTabs(detail)
  return tabs.includes(requested) ? requested : defaultPerformanceDetailTab(detail)
}

export function formatRequestRate(rate: number | null): string {
  return rate === null || !Number.isFinite(rate) || rate <= 0 ? 'closed-loop' : String(rate)
}

export function formatPerformanceTableCell(column: string, value: string | number | null): string {
  if (value === null) return '—'
  const normalized = column
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
  if (
    (normalized === 'rate' || normalized === 'request rate') &&
    String(value).trim().toLocaleUpperCase() === 'INF'
  ) {
    return 'closed-loop'
  }
  return String(value)
}

export function applicableLatencyCharts(
  detail: Pick<PerfDetailResponse, 'api_type' | 'is_embedding'>,
): readonly string[] {
  return isEmbeddingPerformance(detail) ? ['latency'] : PERFORMANCE_LATENCY_CHARTS
}
