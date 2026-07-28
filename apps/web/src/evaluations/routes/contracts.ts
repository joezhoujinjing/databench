import { z } from 'zod'
import { decodeReportKey, encodeReportKey, type ReportRouteKey } from '../domain/report-key.js'

const optionalText = z.string().trim().min(1).max(256).optional()
const positivePage = z.coerce.number().int().min(1).max(1_000_000).default(1)
const pageSize = z.coerce.number().int().min(1).max(500).default(20)
const routeKeyList = z
  .string()
  .regex(/^[A-Za-z0-9_;-]{2,8192}$/u)
  .optional()

export const evaluationTasksSearchSchema = z.object({
  tab: z.enum(['eval', 'perf']).default('eval'),
  source: z.literal('databench').optional(),
  datasetVersion: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  benchmark: optionalText,
  taskId: z
    .string()
    .regex(/^(?:eval|perf)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    .optional(),
})

export const evaluationReportsSearchSchema = z.object({
  search: optionalText,
  models: z.string().max(4096).optional(),
  datasets: z.string().max(4096).optional(),
  scoreMin: z.coerce.number().finite().optional(),
  scoreMax: z.coerce.number().finite().optional(),
  sortBy: z.enum(['score', 'model', 'dataset', 'time']).default('time'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: positivePage,
  pageSize,
})

export const evaluationReportDetailSearchSchema = z.object({
  tab: z.enum(['overview', 'details', 'predictions']).default('overview'),
  dataset: z.string().trim().min(1).max(512).optional(),
  subset: z.string().trim().min(1).max(512).optional(),
})

export const evaluationCompareSearchSchema = z.object({
  reports: routeKeyList,
})

export const evaluationPerformanceSearchSchema = z.object({
  search: optionalText,
  sortBy: z.enum(['time', 'rps', 'latency']).default('time'),
  page: positivePage,
})

export const evaluationPerformanceCompareSearchSchema = z.object({
  runs: routeKeyList,
  embedding: z
    .union([z.literal(0), z.literal(1), z.enum(['0', '1'])])
    .transform((value) => Number(value) as 0 | 1)
    .default(0),
})

export const evaluationBenchmarksSearchSchema = z.object({
  category: z.enum(['all', 'text', 'multimodal', 'agent', 'aigc']).default('all'),
  search: optionalText,
  tag: optionalText,
  page: positivePage,
})

export const evaluationViewerSearchSchema = z.object({
  document: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
})

export function parseReportRouteParams<TName extends 'performanceKey' | 'reportKey'>(
  params: Record<TName, string>,
  name: TName,
): Record<TName, string> | false {
  try {
    return { ...params, [name]: decodeReportKey(params[name]) }
  } catch {
    return false
  }
}

export function stringifyReportRouteParams<TName extends 'performanceKey' | 'reportKey'>(
  params: Record<TName, string | ReportRouteKey>,
  name: TName,
): Record<TName, string> {
  return { ...params, [name]: encodeReportKey(params[name]) }
}
