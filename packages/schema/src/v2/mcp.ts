import { z } from 'zod'
import {
  CANONICAL_DRAFT_FORMAT_V1,
  CANONICAL_DRAFT_SCHEMA_VERSION_V1,
  CanonicalDraftRecordV1Schema,
} from './canonical-draft.js'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import { DatasetViewV2Schema, IngestResultV2Schema } from './contracts.js'
import { JsonObjectSchema } from './json-value.js'
import { PostTrainingRecordV2Schema } from './record.js'

export const MCP_CANONICAL_CONTRACT_VERSION = '2.0.0' as const
export const MCP_CANONICAL_FORMAT = 'canonical-jsonl' as const
export const MCP_CANONICAL_DRAFT_CONTRACT_NAME = 'canonical-draft-import' as const
export const MCP_MAX_PREVIEW_RECORDS = 10

export const McpContractGetInputSchema = z
  .strictObject({
    name: z.enum([MCP_CANONICAL_FORMAT, MCP_CANONICAL_DRAFT_CONTRACT_NAME]),
  })
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

export const McpCanonicalDraftImportContractSchema = z
  .strictObject({
    name: z.literal(MCP_CANONICAL_DRAFT_CONTRACT_NAME),
    version: z.literal(CANONICAL_DRAFT_SCHEMA_VERSION_V1),
    schema: JsonObjectSchema,
    rules: z.array(z.string().min(1)).min(1),
    examples: z.array(McpImportContractExampleSchema).length(3),
    effective_limits: McpImportEffectiveLimitsSchema,
  })
  .superRefine(validateContractExamples)
  .meta({ id: 'McpCanonicalDraftImportContract' })
export type McpCanonicalDraftImportContract = z.infer<typeof McpCanonicalDraftImportContractSchema>

export const McpImportContractSchema = z
  .discriminatedUnion('name', [
    McpCanonicalImportContractSchema,
    McpCanonicalDraftImportContractSchema,
  ])
  .meta({ id: 'McpImportContract' })
export type McpImportContract = z.infer<typeof McpImportContractSchema>

export const McpImportContractToolOutputSchema = z
  .strictObject({
    name: z.enum([MCP_CANONICAL_FORMAT, MCP_CANONICAL_DRAFT_CONTRACT_NAME]),
    version: z.enum([MCP_CANONICAL_CONTRACT_VERSION, CANONICAL_DRAFT_SCHEMA_VERSION_V1]),
    schema: JsonObjectSchema,
    rules: z.array(z.string().min(1)).min(1),
    examples: z.array(McpImportContractExampleSchema).length(3),
    effective_limits: McpImportEffectiveLimitsSchema,
  })
  .superRefine((input, context) => {
    if (!McpImportContractSchema.safeParse(input).success) {
      context.addIssue({ code: 'custom', message: 'import contract fields are inconsistent' })
    }
  })
  .meta({
    id: 'McpImportContractToolOutput',
    oneOf: jsonSchemaOneOf(McpImportContractSchema, 'output'),
  })

const McpPreviewPrepareInputSchema = z.strictObject({
  format: z.enum([MCP_CANONICAL_FORMAT, CANONICAL_DRAFT_FORMAT_V1]),
  action: z.literal('validate-preview'),
  preview_records: z.number().int().min(0).max(MCP_MAX_PREVIEW_RECORDS).default(3),
})

const McpCanonicalImportPrepareInputSchema = z.strictObject({
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('import-dataset'),
})

const McpCanonicalDraftImportPrepareInputSchema = z.strictObject({
  format: z.literal(CANONICAL_DRAFT_FORMAT_V1),
  action: z.literal('import-dataset'),
  expected_input_digest: DigestHexSchema.optional(),
})

const McpCanonicalDraftMaterializePrepareInputSchema = z.strictObject({
  format: z.literal(CANONICAL_DRAFT_FORMAT_V1),
  action: z.literal('materialize-jsonl'),
  expected_input_digest: DigestHexSchema.optional(),
})

export const McpDataProcessPrepareInputSchema = z
  .union([
    McpPreviewPrepareInputSchema,
    McpCanonicalImportPrepareInputSchema,
    McpCanonicalDraftImportPrepareInputSchema,
    McpCanonicalDraftMaterializePrepareInputSchema,
  ])
  .meta({ id: 'McpDataProcessPrepareInput' })
export type McpDataProcessPrepareInput = z.infer<typeof McpDataProcessPrepareInputSchema>

// MCP requires tool JSON Schemas to have `type: object` at the root. Keep the
// exact discriminated branches in `oneOf` while retaining an SDK-compatible
// object schema for runtime validation. This is the wire schema advertised by
// tools/list; the discriminated schema above remains the canonical parsed type.
export const McpDataProcessPrepareToolInputSchema = z
  .strictObject({
    format: z.enum([MCP_CANONICAL_FORMAT, CANONICAL_DRAFT_FORMAT_V1]),
    action: z.enum(['validate-preview', 'import-dataset', 'materialize-jsonl']),
    preview_records: z.number().int().min(0).max(MCP_MAX_PREVIEW_RECORDS).optional(),
    expected_input_digest: DigestHexSchema.optional(),
  })
  .superRefine((input, context) => {
    if (!McpDataProcessPrepareInputSchema.safeParse(input).success) {
      context.addIssue({
        code: 'custom',
        message: 'process fields do not match the selected format and action',
      })
    }
  })
  .meta({
    id: 'McpDataProcessPrepareToolInput',
    oneOf: jsonSchemaOneOf(McpDataProcessPrepareInputSchema, 'input'),
  })

const McpPreparedFileOperationShape = {
  method: z.literal('PUT'),
  put_url: z.string().url(),
  content_type: z.literal('application/x-ndjson'),
  max_bytes: z.number().int().safe().nonnegative(),
  expires_at: Rfc3339UtcSchema,
} as const

const McpPreviewPreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.enum([MCP_CANONICAL_FORMAT, CANONICAL_DRAFT_FORMAT_V1]),
  action: z.literal('validate-preview'),
  response_kind: z.literal('json-preview'),
  side_effects: z.array(z.never()).length(0),
})

const McpCanonicalImportPreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.literal(MCP_CANONICAL_FORMAT),
  action: z.literal('import-dataset'),
  response_kind: z.literal('json-ingest-result'),
  side_effects: z.array(z.literal('dataset_publish')).length(1),
})

const McpCanonicalDraftImportPreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.literal(CANONICAL_DRAFT_FORMAT_V1),
  action: z.literal('import-dataset'),
  response_kind: z.literal('json-ingest-result'),
  side_effects: z.tuple([z.literal('identity_claims'), z.literal('dataset_publish')]),
})

const McpCanonicalDraftMaterializePreparedSchema = z.strictObject({
  ...McpPreparedFileOperationShape,
  format: z.literal(CANONICAL_DRAFT_FORMAT_V1),
  action: z.literal('materialize-jsonl'),
  response_kind: z.literal('canonical-jsonl'),
  side_effects: z.array(z.literal('identity_claims')).length(1),
})

export const McpDataProcessPreparedSchema = z
  .union([
    McpPreviewPreparedSchema,
    McpCanonicalImportPreparedSchema,
    McpCanonicalDraftImportPreparedSchema,
    McpCanonicalDraftMaterializePreparedSchema,
  ])
  .meta({ id: 'McpDataProcessPrepared' })
export type McpDataProcessPrepared = z.infer<typeof McpDataProcessPreparedSchema>

export const McpDataProcessPreparedToolOutputSchema = z
  .strictObject({
    ...McpPreparedFileOperationShape,
    format: z.enum([MCP_CANONICAL_FORMAT, CANONICAL_DRAFT_FORMAT_V1]),
    action: z.enum(['validate-preview', 'import-dataset', 'materialize-jsonl']),
    response_kind: z.enum(['json-preview', 'json-ingest-result', 'canonical-jsonl']),
    side_effects: z.array(z.enum(['dataset_publish', 'identity_claims'])).max(2),
  })
  .superRefine((input, context) => {
    if (!McpDataProcessPreparedSchema.safeParse(input).success) {
      context.addIssue({ code: 'custom', message: 'prepared operation fields are inconsistent' })
    }
  })
  .meta({
    id: 'McpDataProcessPreparedToolOutput',
    oneOf: jsonSchemaOneOf(McpDataProcessPreparedSchema, 'output'),
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

export const McpCanonicalDraftValidationPreviewResultSchema = z
  .strictObject({
    format: z.literal(CANONICAL_DRAFT_FORMAT_V1),
    input_digest: DigestHexSchema,
    record_count: z.number().int().safe().nonnegative(),
    records: z.array(CanonicalDraftRecordV1Schema).max(MCP_MAX_PREVIEW_RECORDS),
    records_truncated: z.boolean(),
  })
  .meta({ id: 'McpCanonicalDraftValidationPreviewResult' })
export type McpCanonicalDraftValidationPreviewResult = z.infer<
  typeof McpCanonicalDraftValidationPreviewResultSchema
>

export const McpValidationPreviewResultSchema = z
  .discriminatedUnion('format', [
    McpCanonicalValidationPreviewResultSchema,
    McpCanonicalDraftValidationPreviewResultSchema,
  ])
  .meta({ id: 'McpValidationPreviewResult' })
export type McpValidationPreviewResult = z.infer<typeof McpValidationPreviewResultSchema>

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

function jsonSchemaOneOf(schema: z.ZodType, io: 'input' | 'output'): readonly unknown[] {
  const projection = z.toJSONSchema(schema, { io })
  const branches = Array.isArray(projection.oneOf)
    ? projection.oneOf
    : Array.isArray(projection.anyOf)
      ? projection.anyOf
      : undefined
  if (branches === undefined) {
    throw new TypeError('Expected a union JSON Schema projection')
  }
  const definitions =
    projection.$defs !== undefined &&
    typeof projection.$defs === 'object' &&
    projection.$defs !== null
      ? (projection.$defs as Record<string, unknown>)
      : {}
  return branches.map((branch) => inlineLocalJsonSchemaRefs(branch, definitions, new Set()))
}

function inlineLocalJsonSchemaRefs(
  value: unknown,
  definitions: Readonly<Record<string, unknown>>,
  resolving: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => inlineLocalJsonSchemaRefs(child, definitions, resolving))
  }
  if (value === null || typeof value !== 'object') return value

  const object = value as Record<string, unknown>
  const reference = object.$ref
  if (typeof reference === 'string' && reference.startsWith('#/$defs/')) {
    const name = reference.slice('#/$defs/'.length)
    const definition = definitions[name]
    if (definition === undefined || resolving.has(name)) {
      throw new TypeError(`Unable to inline JSON Schema reference ${reference}`)
    }
    const nextResolving = new Set(resolving)
    nextResolving.add(name)
    const resolved = inlineLocalJsonSchemaRefs(definition, definitions, nextResolving)
    const siblings = Object.fromEntries(Object.entries(object).filter(([key]) => key !== '$ref'))
    if (Object.keys(siblings).length === 0) return resolved
    return {
      ...(resolved as Record<string, unknown>),
      ...(inlineLocalJsonSchemaRefs(siblings, definitions, resolving) as Record<string, unknown>),
    }
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      inlineLocalJsonSchemaRefs(child, definitions, resolving),
    ]),
  )
}

function validateContractExamples(
  contract: { readonly examples: readonly McpImportContractExample[] },
  context: z.RefinementCtx,
): void {
  if (new Set(contract.examples.map(({ name }) => name)).size !== contract.examples.length) {
    context.addIssue({
      code: 'custom',
      path: ['examples'],
      message: 'contract examples must contain one each of sft, dpo, and rlvr',
    })
  }
}
