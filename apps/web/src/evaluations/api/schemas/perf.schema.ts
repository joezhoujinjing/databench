import { z } from 'zod'

const tableCellSchema = z.union([z.string(), z.number()])

export const perfRunSummarySchema = z.object({
  path: z.string(),
  model: z.string(),
  api_type: z.string(),
  dataset: z.string(),
  num_runs: z.number(),
  total_requests: z.number(),
  success_rate: z.number(),
  best_rps: z.number(),
  best_latency: z.number(),
  is_embedding: z.boolean(),
  has_html: z.boolean(),
  timestamp: z.string(),
  provider: z.string().optional(),
  protocol: z.string().optional(),
  api_host: z.string().optional(),
  concurrency: z.array(z.number()).optional(),
})

export const listPerfRunsResponseSchema = z.object({
  runs: z.array(perfRunSummarySchema),
  total: z.number(),
  report_root_generation: z.string(),
})

export const perfDetailResponseSchema = z.object({
  path: z.string(),
  model: z.string(),
  api_type: z.string(),
  dataset: z.string(),
  generated_at: z.string(),
  basic_info: z.record(z.string(), z.string()),
  summary_columns: z.array(z.string()),
  summary_rows: z.array(z.array(tableCellSchema)),
  best_config: z.record(z.string(), z.string()),
  recommendations: z.array(z.string()),
  num_runs: z.number(),
  is_embedding: z.boolean(),
  has_html: z.boolean(),
})

export const perfRunItemSchema = z.object({
  dir_name: z.string(),
  name: z.string(),
  parallel: z.number(),
  number: z.number(),
  rate: z.number().nullable(),
  total_requests: z.number(),
  succeed_requests: z.number(),
  success_rate: z.number(),
  num_requests: z.number(),
  has_requests: z.boolean(),
  percentile_columns: z.array(z.string()),
  percentile_rows: z.array(z.array(tableCellSchema)),
})

export const perfRunsListResponseSchema = z.object({
  runs: z.array(perfRunItemSchema),
  total: z.number(),
})

export const perfRequestsResponseSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  has_db: z.boolean(),
})
