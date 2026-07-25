import { z } from 'zod'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import { DatasetViewV2Schema, IngestResultV2Schema } from './contracts.js'
import { JsonObjectSchema } from './json-value.js'
import { PostTrainingRecordV2Schema } from './record.js'

export const MCP_CANONICAL_CONTRACT_VERSION = '2.0.0' as const
export const MCP_CANONICAL_FORMAT = 'canonical-jsonl' as const
export const MCP_MAX_PREVIEW_RECORDS = 10

export const McpContractGetInputSchema = z
  .strictObject({ name: z.literal(MCP_CANONICAL_FORMAT) })
  .meta({ id: 'McpContractGetInput' })
export type McpContractGetInput = z.infer<typeof McpContractGetInputSchema>

export const McpImportContractExampleSchema = z.strictObject({
  name: z.enum(['sft', 'dpo', 'rlvr']),
  jsonl: z.string().min(1),
})
export type McpImportContractExample = z.infer<typeof McpImportContractExampleSchema>

export const McpImportEffectiveLimitsSchema = z.strictObject({
  max_request_bytes: z.number().int().safe().nonnegative(),
  max_record_bytes: z.number().int().safe().nonnegative(),
  max_snapshot_records: z.number().int().safe().nonnegative(),
  max_canonical_bytes: z.number().int().safe().nonnegative(),
  max_preview_response_bytes: z.number().int().safe().positive(),
})
export type McpImportEffectiveLimits = z.infer<typeof McpImportEffectiveLimitsSchema>

export const McpCanonicalImportContractSchema = z
  .strictObject({
    name: z.literal(MCP_CANONICAL_FORMAT),
    version: z.literal(MCP_CANONICAL_CONTRACT_VERSION),
    schema: JsonObjectSchema,
    rules: z.array(z.string().min(1)).min(1),
    examples: z.array(McpImportContractExampleSchema).length(3),
    effective_limits: McpImportEffectiveLimitsSchema,
  })
  .superRefine((contract, context) => {
    if (new Set(contract.examples.map(({ name }) => name)).size !== contract.examples.length) {
      context.addIssue({
        code: 'custom',
        path: ['examples'],
        message: 'contract examples must contain one each of sft, dpo, and rlvr',
      })
    }
  })
  .meta({ id: 'McpCanonicalImportContract' })
export type McpCanonicalImportContract = z.infer<typeof McpCanonicalImportContractSchema>

const McpCanonicalPreviewPrepareInputSchema = z.strictObject({
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('validate-preview'),
  preview_records: z.number().int().min(0).max(MCP_MAX_PREVIEW_RECORDS).default(3),
})

const McpCanonicalImportPrepareInputSchema = z.strictObject({
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('import-dataset'),
})

export const McpDataProcessPrepareInputSchema = z
  .discriminatedUnion('action', [
    McpCanonicalPreviewPrepareInputSchema,
    McpCanonicalImportPrepareInputSchema,
  ])
  .meta({ id: 'McpDataProcessPrepareInput' })
export type McpDataProcessPrepareInput = z.infer<typeof McpDataProcessPrepareInputSchema>

// MCP requires tool JSON Schemas to have `type: object` at the root. Keep the
// exact discriminated branches in `oneOf` while retaining an SDK-compatible
// object schema for runtime validation. This is the wire schema advertised by
// tools/list; the discriminated schema above remains the canonical parsed type.
export const McpDataProcessPrepareToolInputSchema = z
  .strictObject({
    format: z.literal(MCP_CANONICAL_FORMAT),
    action: z.enum(['validate-preview', 'import-dataset']),
    preview_records: z.number().int().min(0).max(MCP_MAX_PREVIEW_RECORDS).optional(),
  })
  .superRefine((input, context) => {
    if (!McpDataProcessPrepareInputSchema.safeParse(input).success) {
      context.addIssue({
        code: 'custom',
        message: 'preview_records is only allowed with validate-preview',
      })
    }
  })
  .meta({
    id: 'McpDataProcessPrepareToolInput',
    oneOf: jsonSchemaOneOf(McpDataProcessPrepareInputSchema),
  })

const McpPreparedFileOperationShape = {
  method: z.literal('PUT'),
  put_url: z.string().url(),
  content_type: z.literal('application/x-ndjson'),
  max_bytes: z.number().int().safe().nonnegative(),
  expires_at: Rfc3339UtcSchema,
} as const

const McpCanonicalPreviewPreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('validate-preview'),
  response_kind: z.literal('json-preview'),
  side_effects: z.tuple([]),
})

const McpCanonicalImportPreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('import-dataset'),
  response_kind: z.literal('json-ingest-result'),
  side_effects: z.tuple([z.literal('dataset_publish')]),
})

export const McpDataProcessPreparedSchema = z
  .discriminatedUnion('action', [
    McpCanonicalPreviewPreparedSchema,
    McpCanonicalImportPreparedSchema,
  ])
  .meta({ id: 'McpDataProcessPrepared' })
export type McpDataProcessPrepared = z.infer<typeof McpDataProcessPreparedSchema>

export const McpDataProcessPreparedToolOutputSchema = z
  .strictObject({
    ...McpPreparedFileOperationShape,
    format: z.literal(MCP_CANONICAL_FORMAT),
    action: z.enum(['validate-preview', 'import-dataset']),
    response_kind: z.enum(['json-preview', 'json-ingest-result']),
    side_effects: z.array(z.literal('dataset_publish')).max(1),
  })
  .superRefine((input, context) => {
    if (!McpDataProcessPreparedSchema.safeParse(input).success) {
      context.addIssue({ code: 'custom', message: 'prepared operation fields are inconsistent' })
    }
  })
  .meta({
    id: 'McpDataProcessPreparedToolOutput',
    oneOf: jsonSchemaOneOf(McpDataProcessPreparedSchema),
  })

export const McpCanonicalValidationPreviewResultSchema = z
  .strictObject({
    format: z.literal(MCP_CANONICAL_FORMAT),
    input_digest: DigestHexSchema,
    record_count: z.number().int().safe().nonnegative(),
    records: z.array(PostTrainingRecordV2Schema).max(MCP_MAX_PREVIEW_RECORDS),
    records_truncated: z.boolean(),
  })
  .meta({ id: 'McpCanonicalValidationPreviewResult' })
export type McpCanonicalValidationPreviewResult = z.infer<
  typeof McpCanonicalValidationPreviewResultSchema
>

export const McpCanonicalImportResultSchema = IngestResultV2Schema

export const McpDatasetShowInputSchema = z
  .strictObject({ dataset_version: DigestHexSchema })
  .meta({ id: 'McpDatasetShowInput' })
export type McpDatasetShowInput = z.infer<typeof McpDatasetShowInputSchema>
export const McpDatasetShowResultSchema = DatasetViewV2Schema

export const McpDatasetExportCanonicalPrepareInputSchema = z
  .strictObject({ dataset_version: DigestHexSchema })
  .meta({ id: 'McpDatasetExportCanonicalPrepareInput' })
export type McpDatasetExportCanonicalPrepareInput = z.infer<
  typeof McpDatasetExportCanonicalPrepareInputSchema
>

export const McpDatasetExportCanonicalPreparedSchema = z
  .strictObject({
    method: z.literal('GET'),
    get_url: z.string().url(),
    media_type: z.literal('application/x-ndjson'),
    filename: z.string().min(1),
    dataset_version: DigestHexSchema,
    expires_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'McpDatasetExportCanonicalPrepared' })
export type McpDatasetExportCanonicalPrepared = z.infer<
  typeof McpDatasetExportCanonicalPreparedSchema
>

function jsonSchemaOneOf(schema: z.ZodType): readonly unknown[] {
  const projection = z.toJSONSchema(schema)
  if (!Array.isArray(projection.oneOf)) {
    throw new TypeError('Expected a discriminated union JSON Schema projection')
  }
  return projection.oneOf
}
