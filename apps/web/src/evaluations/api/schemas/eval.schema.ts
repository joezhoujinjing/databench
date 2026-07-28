import { z } from 'zod'

const taskTerminalErrorSchema = z
  .object({
    phase: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
  })
  .strict()

const taskMetricSchema = z
  .object({
    dataset: z.string(),
    subset: z.string().nullable(),
    metric: z.string(),
    score: z.number().finite().nullable(),
    sample_count: z.number().int().nonnegative().nullable(),
    categories: z.array(z.string()),
  })
  .strict()

export const taskTerminalSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      metrics: z.array(taskMetricSchema),
      provider_report_ids: z.array(z.string()),
      error: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.enum(['failed', 'cancelled']),
      metrics: z.null(),
      provider_report_ids: z.null(),
      error: taskTerminalErrorSchema,
    })
    .strict(),
])

export const invokeStatusSchema = z.enum(['ok', 'completed', 'error', 'stopped', 'terminal_replay'])

export const evalInvokeResponseSchema = z.object({
  status: invokeStatusSchema,
  task_id: z.string(),
  result: z.unknown().optional(),
  table: z.string().optional(),
  error: z.string().optional(),
  terminal: taskTerminalSchema.optional(),
})

export const progressResponseSchema = z
  .object({
    percent: z.number(),
    current_step: z.string().optional(),
    terminal: taskTerminalSchema.optional(),
  })
  .catchall(z.unknown())

const benchmarkDescriptionLocaleSchema = z.object({
  full: z.string(),
  sections: z.record(z.string(), z.string()),
})

export const benchmarkEntrySchema = z.object({
  name: z.string(),
  pretty_name: z.string(),
  tags: z.array(z.string()),
  category: z.enum(['llm', 'vlm', 'agent', 'aigc']),
  subset_list: z.array(z.string()),
  total_samples: z.number(),
  few_shot_num: z.number(),
  dataset_id: z.string(),
  paper_url: z.string().nullable(),
  metrics: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  description: z.object({
    en: benchmarkDescriptionLocaleSchema.optional(),
    zh: benchmarkDescriptionLocaleSchema.optional(),
  }),
})

export const benchmarksResponseSchema = z.object({
  text: z.array(benchmarkEntrySchema).optional(),
  multimodal: z.array(benchmarkEntrySchema).optional(),
  agent: z.array(benchmarkEntrySchema).optional(),
  aigc: z.array(benchmarkEntrySchema).optional(),
})
