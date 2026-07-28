import type { PredictionRow, ReportData } from '../api/schemas.js'
import { decodeReportKey, encodeReportKey } from './report-key.js'

export const MAX_COMPARE_MODELS = 3
export type PerModelPredictionFilter = 'above' | 'any' | 'below'

export type TaggedReportData = ReportData & { readonly reportName: string }
export type AlignedPrediction = {
  readonly index: string
  readonly models: Readonly<Record<string, PredictionRow>>
}

export function decodeCompareReports(value: string | undefined): string[] {
  if (!value) return []
  const decoded: string[] = []
  for (const key of value.split(';')) {
    try {
      const report = decodeReportKey(key)
      if (!decoded.includes(report)) decoded.push(report)
    } catch {
      continue
    }
    if (decoded.length === MAX_COMPARE_MODELS) break
  }
  return decoded
}

export function encodeCompareReports(values: readonly string[]): string | undefined {
  const unique = Array.from(new Set(values)).slice(0, MAX_COMPARE_MODELS)
  return unique.length < 2 ? undefined : unique.map(encodeReportKey).join(';')
}

export function commonDatasets(
  rows: readonly TaggedReportData[],
  reportNames: readonly string[],
): string[] {
  if (reportNames.length < 2) return []
  const sets = reportNames.map(
    (name) => new Set(rows.filter((row) => row.reportName === name).map((row) => row.dataset_name)),
  )
  if (sets.some((set) => set.size === 0)) return []
  return Array.from(
    sets.slice(1).reduce((common, set) => {
      return new Set(Array.from(common).filter((dataset) => set.has(dataset)))
    }, sets[0] ?? new Set<string>()),
  ).sort()
}

export function commonSubsets(
  rows: readonly TaggedReportData[],
  reportNames: readonly string[],
  dataset: string,
): string[] {
  const perReport = reportNames.map((reportName) => {
    const names = new Set<string>()
    for (const row of rows) {
      if (row.reportName !== reportName || row.dataset_name !== dataset) continue
      for (const metric of row.metrics) {
        for (const category of metric.categories) {
          for (const subset of category.subsets) {
            if (subset.name !== 'overall_score') names.add(subset.name)
          }
        }
      }
    }
    return names
  })
  if (perReport.some((set) => set.size === 0)) return []
  return Array.from(
    perReport.slice(1).reduce((common, set) => {
      return new Set(Array.from(common).filter((subset) => set.has(subset)))
    }, perReport[0] ?? new Set<string>()),
  ).sort()
}

export function alignPredictions(
  byModel: Readonly<Record<string, readonly PredictionRow[]>>,
  reportNames: readonly string[],
): AlignedPrediction[] {
  if (reportNames.length === 0) return []
  const rows = new Map<string, Record<string, PredictionRow>>()
  for (const name of reportNames) {
    for (const prediction of byModel[name] ?? []) {
      const models = rows.get(prediction.Index) ?? {}
      models[name] = prediction
      rows.set(prediction.Index, models)
    }
  }
  return Array.from(rows, ([index, models]) => ({ index, models })).filter(({ models }) =>
    reportNames.every((name) => models[name] !== undefined),
  )
}

export function filterAlignedPredictions(
  rows: readonly AlignedPrediction[],
  reportNames: readonly string[],
  filters: Readonly<Record<string, PerModelPredictionFilter>>,
  threshold: number,
): AlignedPrediction[] {
  return rows.filter((row) =>
    reportNames.every((name) => {
      const mode = filters[name] ?? 'any'
      const score = row.models[name]?.NScore
      if (mode === 'any') return true
      if (score === undefined) return false
      return mode === 'above' ? score >= threshold : score < threshold
    }),
  )
}

export function aboveRates(
  rows: readonly AlignedPrediction[],
  reportNames: readonly string[],
  threshold: number,
): Record<string, number> {
  return Object.fromEntries(
    reportNames.map((name) => [
      name,
      rows.length === 0
        ? 0
        : rows.filter((row) => (row.models[name]?.NScore ?? Number.NEGATIVE_INFINITY) >= threshold)
            .length / rows.length,
    ]),
  )
}

export function parseModelFilters(
  value: string | undefined,
  reportNames: readonly string[],
): Record<string, PerModelPredictionFilter> {
  const filters: Record<string, PerModelPredictionFilter> = {}
  for (const token of value?.split(';') ?? []) {
    const [rawIndex, mode] = token.split(':')
    const name = reportNames[Number(rawIndex)]
    if (name && (mode === 'any' || mode === 'above' || mode === 'below')) {
      filters[name] = mode
    }
  }
  return filters
}

export function encodeModelFilters(
  filters: Readonly<Record<string, PerModelPredictionFilter>>,
  reportNames: readonly string[],
): string | undefined {
  const tokens = reportNames.flatMap((name) => {
    const mode = filters[name]
    const index = reportNames.indexOf(name)
    return mode === undefined || mode === 'any' ? [] : [`${index}:${mode}`]
  })
  return tokens.length ? tokens.join(';') : undefined
}
