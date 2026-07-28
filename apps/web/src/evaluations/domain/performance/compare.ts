import type { PerfDetailResponse } from '../../api/schemas.js'
import { formatMetricValue, metricSpec } from '../metric.js'

export type DeltaVerdict = 'improvement' | 'incomputable' | 'neutral' | 'regression'
export type SampleTier = 'critical' | 'normal' | 'warning'

export type PerformanceMetricDelta = {
  readonly absolute: number | null
  readonly baseline: number | null
  readonly candidate: number | null
  readonly key: string
  readonly percent: number | null
  readonly verdict: DeltaVerdict
}

export type PerformanceCompareModel = {
  readonly baselineId: string
  readonly candidateId: string
  readonly configDiff: ReadonlyArray<{
    readonly baseline: string
    readonly candidate: string
    readonly key: string
  }>
  readonly deltas: readonly PerformanceMetricDelta[]
  readonly sampleCounts: Readonly<Record<string, number>>
  readonly workloadMismatch: boolean
}

const COLUMN_ALIASES: Readonly<Record<string, string>> = {
  'avg lat s': 'latency',
  'avg tpot ms': 'tpot_ms',
  'avg ttft ms': 'ttft_ms',
  'gen tok s': 'throughput',
  'p99 lat s': 'p99_latency_s',
  'p99 tpot ms': 'p99_tpot_ms',
  'p99 ttft ms': 'p99_ttft_ms',
  rps: 'rps',
  'success rate': 'success_rate',
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value.trim().replaceAll(',', '').replace(/%$/u, ''))
  return Number.isFinite(parsed) ? parsed : null
}

type SummaryRow = PerfDetailResponse['summary_rows'][number]

type WideMetricColumn = {
  readonly columnIndex: number
  readonly key: string
}

function isVerticalSummary(detail: PerfDetailResponse): boolean {
  const columns = detail.summary_columns.map(normalize)
  return columns[0] === 'metric' && columns[1] === 'value'
}

function wideMetricColumns(detail: PerfDetailResponse): WideMetricColumn[] {
  return detail.summary_columns.flatMap((column, columnIndex) => {
    const key = COLUMN_ALIASES[normalize(column)]
    return key ? [{ columnIndex, key }] : []
  })
}

function wideRowConfig(detail: PerfDetailResponse, row: SummaryRow): Record<string, string> {
  const metricIndexes = new Set(wideMetricColumns(detail).map(({ columnIndex }) => columnIndex))
  const aliases: Readonly<Record<string, string>> = {
    conc: 'Concurrency',
    concurrency: 'Concurrency',
    rate: 'Request rate',
  }
  const config: Record<string, string> = {}
  detail.summary_columns.forEach((column, index) => {
    if (metricIndexes.has(index)) return
    config[aliases[normalize(column)] ?? column.trim()] = String(row[index] ?? '').trim()
  })
  return config
}

function configIdentity(config: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)))
}

function matchingWideRows(
  baseline: PerfDetailResponse,
  candidate: PerfDetailResponse,
): { readonly baseline: SummaryRow; readonly candidate: SummaryRow } | null {
  if (isVerticalSummary(baseline) || isVerticalSummary(candidate)) return null
  if (
    baseline.dataset.trim().toLocaleLowerCase() !== candidate.dataset.trim().toLocaleLowerCase()
  ) {
    return null
  }
  const candidates = new Map(
    candidate.summary_rows.map((row) => [configIdentity(wideRowConfig(candidate, row)), row]),
  )
  for (const row of baseline.summary_rows) {
    const match = candidates.get(configIdentity(wideRowConfig(baseline, row)))
    if (match) return { baseline: row, candidate: match }
  }
  return null
}

function metrics(detail: PerfDetailResponse, wideRow?: SummaryRow): Map<string, number | null> {
  const values = new Map<string, number | null>()
  if (isVerticalSummary(detail)) {
    for (const row of detail.summary_rows) {
      const key = String(row[0] ?? '').trim()
      if (key && !values.has(key)) values.set(key, numeric(row[1]))
    }
    return values
  }
  for (const { columnIndex, key } of wideMetricColumns(detail)) {
    values.set(key, wideRow ? numeric(wideRow[columnIndex]) : null)
  }
  return values
}

function aggregatedWideConfig(detail: PerfDetailResponse): Record<string, string> {
  const metricIndexes = new Set(wideMetricColumns(detail).map(({ columnIndex }) => columnIndex))
  const config: Record<string, string> = {}
  detail.summary_columns.forEach((column, index) => {
    if (metricIndexes.has(index)) return
    const values = Array.from(
      new Set(detail.summary_rows.map((row) => String(row[index] ?? '').trim()).filter(Boolean)),
    )
    if (values.length) config[column.trim()] = values.join(', ')
  })
  config['Number of requests'] = String(sampleCount(detail))
  return config
}

function comparisonConfig(
  detail: PerfDetailResponse,
  wideRow?: SummaryRow,
): Record<string, string> {
  if (isVerticalSummary(detail)) return detail.best_config
  return {
    ...(wideRow ? wideRowConfig(detail, wideRow) : aggregatedWideConfig(detail)),
    'Number of requests': String(sampleCount(detail)),
  }
}

function sampleCount(detail: PerfDetailResponse): number {
  for (const [key, value] of Object.entries(detail.basic_info)) {
    if (normalize(key) === 'total requests') return numeric(value) ?? 0
  }
  for (const row of detail.summary_rows) {
    if (normalize(String(row[0] ?? '')) === 'number of requests') return numeric(row[1]) ?? 0
  }
  return 0
}

function timestamp(detail: PerfDetailResponse): number {
  const parsed = Date.parse(detail.generated_at)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function verdict(key: string, baseline: number | null, candidate: number | null): DeltaVerdict {
  if (baseline === null || candidate === null) return 'incomputable'
  if (baseline === candidate) return 'neutral'
  const higher = candidate > baseline
  return higher === (metricSpec(key).spec.direction === 'higher-is-better')
    ? 'improvement'
    : 'regression'
}

function configDiff(
  baseline: Record<string, string>,
  candidate: Record<string, string>,
): PerformanceCompareModel['configDiff'] {
  return Array.from(new Set([...Object.keys(baseline), ...Object.keys(candidate)]))
    .sort()
    .flatMap((key) => {
      const left = baseline[key] ?? ''
      const right = candidate[key] ?? ''
      return left === right ? [] : [{ baseline: left, candidate: right, key }]
    })
}

export function classifyPerformanceSampleSize(count: number): SampleTier {
  if (!Number.isFinite(count) || count < 30) return 'critical'
  if (count < 100) return 'warning'
  return 'normal'
}

export function shouldDeemphasizePercentile(metricKey: string, tier: SampleTier): boolean {
  const match = metricKey.match(/p\s*(90|95|99)/iu)
  if (!match) return false
  if (tier === 'critical') return true
  return tier === 'warning' && Number(match[1]) >= 95
}

export function buildPerformanceCompareModel(
  details: readonly PerfDetailResponse[],
  baselineId?: string,
): PerformanceCompareModel | null {
  if (details.length < 2) return null
  const ordered = [...details].sort((left, right) => timestamp(left) - timestamp(right))
  const baseline = details.find((detail) => detail.path === baselineId) ?? ordered[0]
  if (!baseline) return null
  const candidate = [...details]
    .filter((detail) => detail.path !== baseline.path)
    .sort((left, right) => timestamp(right) - timestamp(left))[0]
  if (!candidate) return null
  const comparesWideRows = !isVerticalSummary(baseline) || !isVerticalSummary(candidate)
  const matchedRows = comparesWideRows ? matchingWideRows(baseline, candidate) : null
  const canCompare = !comparesWideRows || matchedRows !== null
  const left = canCompare
    ? metrics(baseline, matchedRows?.baseline)
    : new Map<string, number | null>()
  const right = canCompare
    ? metrics(candidate, matchedRows?.candidate)
    : new Map<string, number | null>()
  const keys = Array.from(new Set([...left.keys(), ...right.keys()]))
  const deltas = keys.map((key): PerformanceMetricDelta => {
    const baselineValue = left.get(key) ?? null
    const candidateValue = right.get(key) ?? null
    const absolute =
      baselineValue === null || candidateValue === null ? null : candidateValue - baselineValue
    const percent =
      absolute === null || baselineValue === null || baselineValue === 0
        ? null
        : (absolute / Math.abs(baselineValue)) * 100
    return {
      absolute,
      baseline: baselineValue,
      candidate: candidateValue,
      key,
      percent,
      verdict: verdict(key, baselineValue, candidateValue),
    }
  })
  return {
    baselineId: baseline.path,
    candidateId: candidate.path,
    configDiff: configDiff(
      comparisonConfig(baseline, matchedRows?.baseline),
      comparisonConfig(candidate, matchedRows?.candidate),
    ),
    deltas,
    sampleCounts: {
      [baseline.path]: sampleCount(baseline),
      [candidate.path]: sampleCount(candidate),
    },
    workloadMismatch: comparesWideRows
      ? matchedRows === null
      : baseline.dataset.trim().toLocaleLowerCase() !==
        candidate.dataset.trim().toLocaleLowerCase(),
  }
}

export function formatPerformanceDelta(delta: PerformanceMetricDelta): {
  readonly absolute: string
  readonly baseline: string
  readonly candidate: string
  readonly percent: string
} {
  return {
    absolute: formatMetricValue(delta.key, delta.absolute).primary,
    baseline: formatMetricValue(delta.key, delta.baseline).primary,
    candidate: formatMetricValue(delta.key, delta.candidate).primary,
    percent: delta.percent === null ? '—' : `${delta.percent.toFixed(1)}%`,
  }
}
