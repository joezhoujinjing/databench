import { z } from 'zod'
import { EVALSCOPE_PLOTLY_ASSET_SHA256, EVALSCOPE_UPSTREAM_COMMIT } from '../config.js'

const opaqueDocumentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)

export const serviceHealthSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('evalscope-backend'),
    ready: z.literal(true),
    evalscope_commit: z.literal(EVALSCOPE_UPSTREAM_COMMIT),
  })
  .strict()

export const evalScopePublicConfigSchema = z
  .object({
    service_version: z.string().min(1).max(64),
    evalscope_commit: z.literal(EVALSCOPE_UPSTREAM_COMMIT),
    capabilities: z.array(
      z.enum(['evaluation', 'performance', 'reports', 'databench-dataset', 'generated-documents']),
    ),
    reports_configured: z.boolean(),
    report_root_generation: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u),
    plotly_asset_sha256: z.literal(EVALSCOPE_PLOTLY_ASSET_SHA256),
  })
  .strict()

export const generatedDocumentDescriptorSchema = z
  .object({
    document_id: opaqueDocumentIdSchema,
    document_url: z.string().regex(/^\/evalscope-api\/generated-documents\/[A-Za-z0-9_-]{43}$/u),
    expires_at: z.number().int().positive(),
    kind: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.document_url !== `/evalscope-api/generated-documents/${value.document_id}`) {
      context.addIssue({
        code: 'custom',
        message: 'Generated document URL does not match its opaque ID',
        path: ['document_url'],
      })
    }
  })

export const dataFrameResponseSchema = z.object({
  columns: z.array(z.string()),
  data: z.array(z.record(z.string(), z.unknown())),
})

export const logResponseSchema = z.object({
  text: z.string(),
  head_line: z.number().int().nonnegative(),
  tail_line: z.number().int().nonnegative(),
  total_lines: z.number().int().nonnegative(),
})

export const taskStatusResponseSchema = z.object({
  status: z.string(),
  task_id: z.string(),
  terminal: z.unknown().optional(),
  provider_signal: z.string().optional(),
})

export type EvalScopePublicConfig = z.infer<typeof evalScopePublicConfigSchema>
export type GeneratedDocumentDescriptor = z.infer<typeof generatedDocumentDescriptorSchema>
