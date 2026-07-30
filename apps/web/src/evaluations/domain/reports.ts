import type {
  ChatMessage,
  DatabenchReportSource,
  DataFrameResponse,
  MetricData,
  PredictionRow,
  ReportData,
} from '../api/schemas.js'
import { metricSpec, metricsAreComparable, resolveMetricKey } from './metric.js'

export const REPORT_PAGE_SIZE = 20
export const MAX_REPORT_SELECTION = 5

export function databenchDatasetLabel(source: DatabenchReportSource): string {
  return source.source_ref ?? source.dataset_version.slice(0, 12)
}

export type PredictionMode = 'all' | 'above' | 'below'

export function decodeFilterList(value: string | undefined): string[] {
  if (value === undefined) return []
  return Array.from(
    new Set(
      value
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 64)
}

export function encodeFilterList(values: readonly string[]): string | undefined {
  const clean = Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
  return clean.length === 0 ? undefined : clean.join(';')
}

export function toggleReportSelection(
  selected: readonly string[],
  reportName: string,
): { readonly next: string[]; readonly rejected: boolean } {
  if (selected.includes(reportName)) {
    return { next: selected.filter((name) => name !== reportName), rejected: false }
  }
  if (selected.length >= MAX_REPORT_SELECTION) return { next: [...selected], rejected: true }
  return { next: [...selected, reportName], rejected: false }
}

export function toggleCurrentPageSelection(
  selected: readonly string[],
  currentPage: readonly string[],
): { readonly next: string[]; readonly rejected: boolean } {
  const allSelected = currentPage.length > 0 && currentPage.every((name) => selected.includes(name))
  if (allSelected) {
    return { next: selected.filter((name) => !currentPage.includes(name)), rejected: false }
  }
  const next = [...selected]
  let rejected = false
  for (const name of currentPage) {
    if (next.includes(name)) continue
    if (next.length >= MAX_REPORT_SELECTION) {
      rejected = true
      break
    }
    next.push(name)
  }
  return { next, rejected }
}

export type ReportSummaryStats = {
  readonly average: number | null
  readonly best: { readonly dataset: string; readonly score: number } | null
  readonly metricName: string
  readonly totalSamples: number
  readonly worst: { readonly dataset: string; readonly score: number } | null
}

export function resolvePrimaryMetric(report: ReportData): MetricData | undefined {
  if (report.primary_output_key != null) {
    return report.metrics.find((metric) => metric.name === report.primary_output_key)
  }
  return report.metrics[0]
}

export function summarizeReportData(reports: readonly ReportData[]): ReportSummaryStats | null {
  if (reports.length === 0) return null
  const metricNames = reports.map((report) => resolvePrimaryMetric(report)?.name ?? 'score')
  const comparable = metricsAreComparable(metricNames)
  const metricName = metricNames[0] ?? 'score'
  const totalSamples = reports.reduce(
    (sum, report) =>
      sum +
      (resolvePrimaryMetric(report)?.num ??
        resolvePrimaryMetric(report)?.categories.reduce((n, category) => n + category.num, 0) ??
        0),
    0,
  )
  if (!comparable) {
    return { average: null, best: null, metricName: '', totalSamples, worst: null }
  }
  const direction = metricSpec(metricName).spec.direction
  const ordered = reports
    .map((report) => ({ dataset: report.dataset_name, score: report.score }))
    .sort((left, right) =>
      direction === 'higher-is-better' ? right.score - left.score : left.score - right.score,
    )
  return {
    average: reports.reduce((sum, report) => sum + report.score, 0) / reports.length,
    best: ordered[0] ?? null,
    metricName,
    totalSamples,
    worst: ordered.at(-1) ?? null,
  }
}

export type OverviewRow = {
  readonly dataset: string
  readonly metric: string
  readonly samples: number
  readonly score: number
}

export function reportOverviewRows(reports: readonly ReportData[]): OverviewRow[] {
  return reports.map((report) => ({
    dataset: report.dataset_name,
    metric: resolvePrimaryMetric(report)?.name ?? 'score',
    samples: resolvePrimaryMetric(report)?.num ?? 0,
    score: report.score,
  }))
}

export type SubsetRow = {
  readonly metric: string
  readonly samples: number
  readonly score: number
  readonly subset: string
}

export function subsetRows(frame: DataFrameResponse): SubsetRow[] {
  const seen = new Set<string>()
  const rows: SubsetRow[] = []
  for (const row of frame.data) {
    const categoryKey = Object.keys(row).find((key) => key.startsWith('Cat.'))
    if (categoryKey !== undefined && row[categoryKey] === '-') continue
    const subset = typeof row.Subset === 'string' ? row.Subset : String(row.Subset ?? '')
    if (subset === '' || seen.has(subset)) continue
    const score = Number(row.Score)
    const samples = Number(row.Num)
    if (!Number.isFinite(score) || !Number.isFinite(samples)) continue
    seen.add(subset)
    rows.push({
      metric: typeof row.Metric === 'string' ? row.Metric : 'score',
      samples,
      score,
      subset,
    })
  }
  return rows
}

export function filterPredictions(
  predictions: readonly PredictionRow[],
  mode: PredictionMode,
  threshold: number,
): PredictionRow[] {
  if (mode === 'all') return [...predictions]
  return predictions.filter((prediction) =>
    mode === 'above' ? prediction.NScore >= threshold : prediction.NScore < threshold,
  )
}

export function predictionCounts(
  predictions: readonly PredictionRow[],
  threshold: number,
): { readonly above: number; readonly all: number; readonly below: number } {
  const above = predictions.filter((prediction) => prediction.NScore >= threshold).length
  return { above, all: predictions.length, below: predictions.length - above }
}

export function findPredictionByIndex(
  predictions: readonly PredictionRow[],
  query: string,
): number | null {
  const index = predictions.findIndex((prediction) => prediction.Index === query.trim())
  return index < 0 ? null : index
}

export type MessagePrefixResult =
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'found'; readonly messageId: string; readonly predictionIndex: number }

export function findPredictionByMessagePrefix(
  predictions: readonly PredictionRow[],
  query: string,
): MessagePrefixResult {
  const prefix = query.trim()
  if (prefix === '') return { kind: 'not-found' }
  const matches: Array<{ messageId: string; predictionIndex: number }> = []
  predictions.forEach((prediction, predictionIndex) => {
    for (const message of prediction.Messages ?? []) {
      if (message.id?.startsWith(prefix)) {
        matches.push({ messageId: message.id, predictionIndex })
      }
    }
  })
  if (matches.length === 0) return { kind: 'not-found' }
  if (matches.length > 1) return { kind: 'ambiguous' }
  const match = matches[0]
  return match === undefined ? { kind: 'not-found' } : { kind: 'found', ...match }
}

export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'reasoning') return block.reasoning ?? ''
      if (block.type === 'image') return '[image]'
      if (block.type === 'audio') return '[audio]'
      if (block.type === 'video') return '[video]'
      return block.data === undefined ? '' : JSON.stringify(block.data)
    })
    .filter(Boolean)
    .join('\n\n')
}

export function reportMetricsAreHomogeneous(reports: readonly ReportData[]): boolean {
  const keys = reports.map((report) =>
    resolveMetricKey(resolvePrimaryMetric(report)?.name ?? 'score'),
  )
  return keys.length > 0 && keys.every((key) => key === keys[0])
}
