import { z } from 'zod'

export const invokeStatusSchema = z.enum(['ok', 'completed', 'error', 'stopped'])

export const evalInvokeResponseSchema = z.object({
  status: invokeStatusSchema,
  task_id: z.string(),
  result: z.unknown().optional(),
  table: z.string().optional(),
  error: z.string().optional(),
})

export const progressResponseSchema = z
  .object({
    percent: z.number(),
    current_step: z.string().optional(),
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
