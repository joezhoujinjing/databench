export type MetricBoundedness = 'bounded' | 'unbounded'
export type MetricDirection = 'higher-is-better' | 'lower-is-better'

export type MetricDisplaySpec = {
  readonly boundedness: MetricBoundedness
  readonly direction: MetricDirection
  readonly key: string
  readonly percentPrecision: number
  readonly rawPrecision: number
  readonly storedAsHundred?: boolean
  readonly unit: string | null
}

export type FormattedMetric = {
  readonly isMissing: boolean
  readonly isSpecUndefined: boolean
  readonly primary: string
  readonly raw: string
}

const DEFAULT_METRIC_SPEC: MetricDisplaySpec = {
  boundedness: 'unbounded',
  direction: 'higher-is-better',
  key: '',
  percentPrecision: 1,
  rawPrecision: 4,
  unit: null,
}

const bounded = (key: string, storedAsHundred = false): MetricDisplaySpec => ({
  boundedness: 'bounded',
  direction: 'higher-is-better',
  key,
  percentPrecision: 1,
  rawPrecision: 4,
  ...(storedAsHundred ? { storedAsHundred: true } : {}),
  unit: null,
})

const unbounded = (
  key: string,
  unit: string,
  rawPrecision: number,
  direction: MetricDirection,
): MetricDisplaySpec => ({
  boundedness: 'unbounded',
  direction,
  key,
  percentPrecision: 1,
  rawPrecision,
  unit,
})

export const METRIC_REGISTRY: Readonly<Record<string, MetricDisplaySpec>> = {
  accuracy: bounded('accuracy'),
  exact_match: bounded('exact_match'),
  f1: bounded('f1'),
  pass_rate: bounded('pass_rate'),
  precision: bounded('precision'),
  recall: bounded('recall'),
  score_percent: bounded('score_percent', true),
  success_rate: bounded('success_rate', true),
  latency: unbounded('latency', 's', 2, 'lower-is-better'),
  rps: unbounded('rps', 'req/s', 2, 'higher-is-better'),
  throughput: unbounded('throughput', 'tokens/s', 2, 'higher-is-better'),
  tokens: unbounded('tokens', 'tokens', 0, 'higher-is-better'),
  tpot: unbounded('tpot', 's', 4, 'lower-is-better'),
  tpot_ms: unbounded('tpot_ms', 'ms', 2, 'lower-is-better'),
  ttft: unbounded('ttft', 's', 3, 'lower-is-better'),
  ttft_ms: unbounded('ttft_ms', 'ms', 2, 'lower-is-better'),
}

const METRIC_ALIASES: Readonly<Record<string, string>> = {
  acc: 'accuracy',
  average_accuracy: 'accuracy',
  avg_score: 'accuracy',
  boundary_precision: 'precision',
  em: 'exact_match',
  exactmatch: 'exact_match',
  f1_score: 'f1',
  mean_acc: 'accuracy',
  output_tps: 'throughput',
  pass_1: 'pass_rate',
  'pass@1': 'pass_rate',
  passrate: 'pass_rate',
  req_per_sec: 'rps',
  score: 'accuracy',
  strict_pass: 'pass_rate',
  success: 'success_rate',
  successrate: 'success_rate',
}

export function resolveMetricKey(key: string): string {
  if (key in METRIC_REGISTRY) return key
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  for (const candidate of [normalized, normalized.replace(/^(?:mean|sum)_/u, '')]) {
    if (candidate in METRIC_REGISTRY) return candidate
    const alias = METRIC_ALIASES[candidate]
    if (alias !== undefined) return alias
  }
  return normalized
}

export function metricSpec(key: string): {
  readonly fallback: boolean
  readonly spec: MetricDisplaySpec
} {
  const spec = METRIC_REGISTRY[resolveMetricKey(key)]
  return spec === undefined
    ? { fallback: true, spec: DEFAULT_METRIC_SPEC }
    : { fallback: false, spec }
}

export function roundHalfUp(value: number, precision: number): number {
  if (!Number.isFinite(value)) return value
  const safePrecision = Math.max(0, precision)
  const shifted = Number(`${value}e${safePrecision}`)
  if (Number.isFinite(shifted)) {
    const rounded = Number(`${Math.round(shifted)}e${-safePrecision}`)
    if (Number.isFinite(rounded)) return rounded
  }
  const factor = 10 ** safePrecision
  return Math.round(value * factor) / factor
}

export function formatMetricValue(key: string, value: number | null | undefined): FormattedMetric {
  const { fallback, spec } = metricSpec(key)
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { isMissing: true, isSpecUndefined: fallback, primary: '—', raw: '—' }
  }
  if (spec.boundedness === 'bounded') {
    const ratio = spec.storedAsHundred === true ? value / 100 : value
    return {
      isMissing: false,
      isSpecUndefined: false,
      primary: `${roundHalfUp(ratio * 100, spec.percentPrecision).toFixed(spec.percentPrecision)}%`,
      raw: roundHalfUp(ratio, spec.rawPrecision).toFixed(spec.rawPrecision),
    }
  }
  const raw = roundHalfUp(value, spec.rawPrecision).toFixed(spec.rawPrecision)
  return {
    isMissing: false,
    isSpecUndefined: fallback,
    primary: spec.unit === null ? raw : `${raw} ${spec.unit}`,
    raw,
  }
}

export function boundedMetricRatio(key: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const { fallback, spec } = metricSpec(key)
  if (fallback || spec.boundedness !== 'bounded') return null
  const ratio = spec.storedAsHundred === true ? value / 100 : value
  return Math.max(0, Math.min(1, ratio))
}

export function metricsAreComparable(keys: readonly string[]): boolean {
  if (keys.length === 0) return false
  const resolved = resolveMetricKey(keys[0] ?? '')
  return keys.every((key) => resolveMetricKey(key) === resolved)
}

export function metricSupportsRadar(keys: readonly string[]): boolean {
  if (keys.length < 3 || !metricsAreComparable(keys)) return false
  return metricSpec(keys[0] ?? '').spec.boundedness === 'bounded'
}
