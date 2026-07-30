import { z } from 'zod'

export const subsetDataSchema = z.object({
  name: z.string(),
  score: z.number(),
  num: z.number(),
})

export const categoryDataSchema = z.object({
  name: z.array(z.string()),
  num: z.number(),
  score: z.number(),
  subsets: z.array(subsetDataSchema),
})

export const metricDataSchema = z.object({
  name: z.string(),
  num: z.number(),
  score: z.number(),
  categories: z.array(categoryDataSchema).default([]),
})

export const percentileStatsSchema = z.object({
  mean: z.number(),
  std: z.number().nullable(),
  min: z.number(),
  '25%': z.number(),
  '50%': z.number(),
  '75%': z.number(),
  '90%': z.number(),
  '99%': z.number(),
  max: z.number(),
})

export const perfMetricsSummarySchema = z.object({
  n_samples: z.number(),
  latency: percentileStatsSchema,
  throughput: z.object({
    avg_output_tps: z.number(),
    avg_req_ps: z.number(),
  }),
  usage: z.object({
    input_tokens: percentileStatsSchema,
    output_tokens: percentileStatsSchema,
    total_tokens: percentileStatsSchema,
    total_input_tokens: z.number().optional(),
    total_output_tokens: z.number().optional(),
    total_tokens_count: z.number().optional(),
  }),
  ttft: percentileStatsSchema.optional(),
  tpot: percentileStatsSchema.optional(),
})

export const perfMetricsSchema = z.object({ summary: perfMetricsSummarySchema })

export const databenchReportSourceSchema = z.object({
  source_ref: z.string().nullable(),
  dataset_version: z.string().regex(/^[0-9a-f]{64}$/u),
  benchmark: z.literal('general_qa'),
})

export const reportDataSchema = z.object({
  name: z.string(),
  dataset_name: z.string(),
  model_name: z.string(),
  score: z.number(),
  analysis: z.string().default(''),
  metrics: z.array(metricDataSchema).default([]),
  perf_metrics: perfMetricsSchema.nullable().optional(),
})

export const loadReportResponseSchema = z.object({
  report_list: z.array(reportDataSchema),
  datasets: z.array(z.string()),
  task_config: z.record(z.string(), z.unknown()),
  databench_source: databenchReportSourceSchema.optional(),
})

export const loadMultiReportResponseSchema = z.object({
  report_list: z.array(reportDataSchema),
})

export const reportSummarySchema = z.object({
  name: z.string(),
  model_name: z.string(),
  dataset_name: z.string(),
  score: z.number(),
  metric_name: z.string().optional(),
  dataset_scores: z.record(z.string(), z.number()).optional(),
  num_samples: z.number(),
  timestamp: z.string(),
  databench_source: databenchReportSourceSchema.optional(),
})

export const listReportsResponseSchema = z.object({
  reports: z.array(reportSummarySchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  filters: z.object({
    available_models: z.array(z.string()),
    available_datasets: z.array(z.string()),
  }),
  report_root_generation: z.string(),
})

export const samplePerfMetricsSchema = z.object({
  latency: z.number(),
  ttft: z.number().nullable().optional(),
  tpot: z.number().nullable().optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
})

export const contentBlockSchema = z
  .object({
    type: z.string().min(1).max(64),
    text: z.string().optional(),
    reasoning: z.string().optional(),
    reasoning_tokens: z.number().nullable().optional(),
    image: z.string().optional(),
    audio: z.string().optional(),
    video: z.string().optional(),
    format: z.string().optional(),
    detail: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export const toolCallSchema = z.object({
  id: z.string(),
  function: z.string(),
  arguments: z.record(z.string(), z.unknown()),
})

export const toolMessageErrorSchema = z.object({
  type: z.string().nullable().optional(),
  message: z.string(),
})

export const chatMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  perf_metrics: samplePerfMetricsSchema.nullable().optional(),
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  model: z.string().nullable().optional(),
  tool_call_id: z.string().nullable().optional(),
  function: z.string().nullable().optional(),
  error: toolMessageErrorSchema.nullable().optional(),
})

export const agentTraceEventTypeSchema = z.string().min(1).max(64)

export const agentTraceEventSchema = z.object({
  step: z.number(),
  timestamp: z.number(),
  type: agentTraceEventTypeSchema,
  message_id: z.string().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  token_usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    })
    .nullable()
    .optional(),
  payload: z.record(z.string(), z.unknown()),
})

export const agentTraceSchema = z.object({
  strategy: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  max_steps: z.number(),
  events: z.array(agentTraceEventSchema),
})

export const predictionRowSchema = z
  .object({
    Index: z.string(),
    Input: z.string().default(''),
    Metadata: z.unknown().default({}),
    Generated: z.string().default(''),
    Gold: z.string().default(''),
    Pred: z.string().default(''),
    Score: z.record(z.string(), z.unknown()).default({}),
    NScore: z.number(),
    PerfMetrics: samplePerfMetricsSchema.nullable().optional(),
    Messages: z.array(chatMessageSchema).nullable().optional(),
    AgentTrace: agentTraceSchema.nullable().optional(),
  })
  .passthrough()

export const predictionsResponseSchema = z.object({
  predictions: z.array(predictionRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  counts: z.object({
    all: z.number().int().nonnegative(),
    above: z.number().int().nonnegative(),
    below: z.number().int().nonnegative(),
  }),
  match: z
    .discriminatedUnion('status', [
      z.object({ status: z.literal('not-found') }),
      z.object({ status: z.literal('ambiguous') }),
      z.object({
        status: z.literal('found'),
        position: z.number().int().positive(),
        page: z.number().int().positive(),
        message_id: z.string().optional(),
      }),
    ])
    .optional(),
})

export const analysisResponseSchema = z.object({ analysis: z.string() })

export type AgentTrace = z.infer<typeof agentTraceSchema>
export type AgentTraceEvent = z.infer<typeof agentTraceEventSchema>
export type ChatMessage = z.infer<typeof chatMessageSchema>
export type ContentBlock = z.infer<typeof contentBlockSchema>
export type DatabenchReportSource = z.infer<typeof databenchReportSourceSchema>
export type ListReportsResponse = z.infer<typeof listReportsResponseSchema>
export type LoadReportResponse = z.infer<typeof loadReportResponseSchema>
export type PerfMetrics = z.infer<typeof perfMetricsSchema>
export type PredictionRow = z.infer<typeof predictionRowSchema>
export type ReportData = z.infer<typeof reportDataSchema>
export type ReportSummary = z.infer<typeof reportSummarySchema>
export type ToolCall = z.infer<typeof toolCallSchema>
