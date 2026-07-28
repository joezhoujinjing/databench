import { canonicalJsonV2, hashV2Record } from '@databench/hashing'
import { z } from 'zod'
import { ConflictError } from '../errors.js'
import {
  DigestHexSchema,
  NonNegativeSafeIntegerSchema,
  RecordIdSchema,
  Rfc3339UtcSchema,
} from './common.js'
import {
  type ConverterNameV2,
  ConverterNameV2Schema,
  FidelityErrorDetailV2Schema,
  V2_CONVERTER_NAMES,
} from './converter.js'
import { DatasetManifestV2Schema } from './manifest.js'
import {
  deriveRecordEligibilityV2,
  RecordEligibilityV2Schema,
  RecordSummaryV2Schema,
} from './projection.js'
import { PostTrainingRecordV2Schema } from './record.js'

export const V2_RECORD_PAGE_MAX_LIMIT = 500
export const V2_CURSOR_PAGE_DEFAULT_LIMIT = 50
export const V2_CURSOR_PAGE_MAX_LIMIT = 500
export const V2_CURSOR_MAX_CHARS = 1536

export const V2_API_VERSIONS = ['2'] as const
export const V2_RECORD_SCHEMA_VERSIONS = ['2.0.0'] as const
export const V2_IDENTITY_PROFILES = ['databench-v2-jcs-1'] as const
export const V2_LAYOUT_VERSIONS = ['record-json-v1'] as const
export const V2_EXPORT_FIDELITY_PROFILES = ['databench-export-fidelity-1'] as const

export const V2PrivateResponseHeadersSchema = z.strictObject({
  'X-Request-ID': z.string().uuid(),
  'Cache-Control': z.literal('private, no-store'),
  'X-Content-Type-Options': z.literal('nosniff'),
})

export const V2BinaryResponseHeadersSchema = V2PrivateResponseHeadersSchema.extend({
  'Content-Disposition': z.string().min(1),
  'Content-Length': z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .optional(),
})

const REF_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export const RefNameV2Schema = z
  .string()
  .regex(REF_NAME_PATTERN)
  .superRefine((value, context) => {
    if (value === '.' || value === '..' || DigestHexSchema.safeParse(value).success) {
      context.addIssue({ code: 'custom', message: 'Expected an unambiguous V2 ref name' })
    }
  })

export const RefOrVersionV2Schema = z.union([DigestHexSchema, RefNameV2Schema])

export const TransformJobStateConflictDetailV2Schema = z
  .strictObject({
    reason: z.enum(['not_retryable', 'cleanup_pending']),
    job_id: z.string().regex(/^job_[0-9a-f]{64}$/),
    status: z.enum([
      'queued',
      'leased',
      'running',
      'finalizing',
      'completed',
      'failed',
      'cancelled',
    ]),
  })
  .meta({ id: 'TransformJobStateConflictDetailV2' })
export type TransformJobStateConflictDetailV2 = z.infer<
  typeof TransformJobStateConflictDetailV2Schema
>

export const EvaluationRunStateConflictDetailV2Schema = z
  .strictObject({
    reason: z.enum([
      'create_request_mismatch',
      'invalid_transition',
      'terminal_body_mismatch',
      'archive_invalid_transition',
      'archive_attempt_mismatch',
      'archive_body_mismatch',
    ]),
    run_id: z.uuid(),
    status: z.enum(['prepared', 'running', 'completed', 'failed', 'cancelled']),
    requested_status: z.enum(['running', 'completed', 'failed', 'cancelled']).nullable(),
    archive_status: z
      .enum(['not_requested', 'pending', 'uploading', 'available', 'failed'])
      .optional(),
    archive_attempt: z.number().int().safe().nonnegative().optional(),
    requested_archive_status: z.enum(['uploading', 'available', 'failed']).optional(),
  })
  .meta({ id: 'EvaluationRunStateConflictDetailV2' })
export type EvaluationRunStateConflictDetailV2 = z.infer<
  typeof EvaluationRunStateConflictDetailV2Schema
>

export const PostTrainingV2LimitsSchema = z
  .strictObject({
    max_record_bytes: z.number().int().safe().nonnegative(),
    max_snapshot_records: z.number().int().safe().nonnegative(),
    max_canonical_bytes: z.number().int().safe().nonnegative(),
    max_request_bytes: z.number().int().safe().nonnegative(),
    max_nesting_depth: z.number().int().safe().nonnegative(),
    max_json_schema_bytes: z.number().int().safe().positive(),
    max_json_schema_nodes: z.number().int().safe().positive(),
    max_lineage_depth: z.number().int().safe().positive(),
    max_lineage_nodes: z.number().int().safe().positive(),
    max_transform_inputs: z.number().int().safe().positive(),
    max_transform_working_set_bytes: z.number().int().safe().nonnegative(),
    max_concurrent_transforms: z.number().int().safe().positive(),
  })
  .meta({ id: 'PostTrainingV2Limits' })
export type PostTrainingV2Limits = z.infer<typeof PostTrainingV2LimitsSchema>

export const PostTrainingV2CapabilitySchema = z
  .strictObject({
    enabled: z.boolean(),
    api_versions: z.tuple([z.literal(V2_API_VERSIONS[0])]),
    record_schema_versions: z.tuple([z.literal(V2_RECORD_SCHEMA_VERSIONS[0])]),
    identity_profiles: z.tuple([z.literal(V2_IDENTITY_PROFILES[0])]),
    layout_versions: z.tuple([z.literal(V2_LAYOUT_VERSIONS[0])]),
    export_fidelity_profiles: z.tuple([z.literal(V2_EXPORT_FIDELITY_PROFILES[0])]),
    converters: z.array(ConverterNameV2Schema).max(V2_CONVERTER_NAMES.length),
    limits: PostTrainingV2LimitsSchema,
  })
  .superRefine((capability, context) => {
    for (let index = 1; index < capability.converters.length; index += 1) {
      const previous = capability.converters[index - 1]
      const current = capability.converters[index]
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: 'custom',
          path: ['converters', index],
          message: 'capability converters must be strictly ASCII sorted and unique',
        })
      }
    }
  })
  .meta({ id: 'PostTrainingV2Capability' })
export type PostTrainingV2Capability = z.infer<typeof PostTrainingV2CapabilitySchema>

export function createPostTrainingV2Capability(input: {
  readonly enabled: boolean
  readonly converters: readonly ConverterNameV2[]
  readonly limits: PostTrainingV2Limits
}): PostTrainingV2Capability {
  return PostTrainingV2CapabilitySchema.parse({
    enabled: input.enabled,
    api_versions: V2_API_VERSIONS,
    record_schema_versions: V2_RECORD_SCHEMA_VERSIONS,
    identity_profiles: V2_IDENTITY_PROFILES,
    layout_versions: V2_LAYOUT_VERSIONS,
    export_fidelity_profiles: V2_EXPORT_FIDELITY_PROFILES,
    converters: input.converters,
    limits: input.limits,
  })
}

export const DatasetRefOrVersionParamsV2Schema = z
  .strictObject({ ref_or_version: RefOrVersionV2Schema })
  .meta({ id: 'DatasetRefOrVersionParamsV2' })
export type DatasetRefOrVersionParamsV2 = z.infer<typeof DatasetRefOrVersionParamsV2Schema>

export const DatasetVersionParamsV2Schema = z
  .strictObject({ dataset_version: DigestHexSchema })
  .meta({ id: 'DatasetVersionParamsV2' })
export type DatasetVersionParamsV2 = z.infer<typeof DatasetVersionParamsV2Schema>

export const DatasetRecordParamsV2Schema = z
  .strictObject({
    ref_or_version: RefOrVersionV2Schema,
    record_id: RecordIdSchema,
  })
  .meta({ id: 'DatasetRecordParamsV2' })
export type DatasetRecordParamsV2 = z.infer<typeof DatasetRecordParamsV2Schema>

export const RefParamsV2Schema = z
  .strictObject({ name: RefNameV2Schema })
  .meta({ id: 'RefParamsV2' })
export type RefParamsV2 = z.infer<typeof RefParamsV2Schema>

export const AddRecordsV2OptionsSchema = z
  .strictObject({
    ref: RefNameV2Schema.nullable(),
    expected_ref_version: DigestHexSchema.nullable(),
    message: z.string().min(1).nullable(),
  })
  .superRefine((options, context) => {
    if (options.ref === null && options.expected_ref_version !== null) {
      context.addIssue({
        code: 'custom',
        path: ['expected_ref_version'],
        message: 'expected_ref_version requires ref',
      })
    }
    if (options.ref === null && options.message !== null) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'message requires ref' })
    }
  })
export type AddRecordsV2Options = z.infer<typeof AddRecordsV2OptionsSchema>

// OpenAPI represents multipart files and binary responses as strings with the
// binary format. Runtime multipart parsing remains streaming and validates the
// text fields with AddRecordsV2OptionsSchema.
export const BinaryBodyV2Schema = z.string().meta({ format: 'binary' })

export const IngestCanonicalV2FormSchema = z
  .strictObject({
    file: BinaryBodyV2Schema,
    ref: RefNameV2Schema.optional(),
    expected_ref_version: DigestHexSchema.optional(),
    message: z.string().min(1).optional(),
  })
  .superRefine((form, context) => {
    if (form.ref === undefined && form.expected_ref_version !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expected_ref_version'],
        message: 'expected_ref_version requires ref',
      })
    }
    if (form.ref === undefined && form.message !== undefined) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'message requires ref' })
    }
  })
  .meta({ id: 'IngestCanonicalV2Form' })
export type IngestCanonicalV2Form = z.infer<typeof IngestCanonicalV2FormSchema>

export const RefUpdateResultV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not_requested') }),
  z.strictObject({
    status: z.literal('updated'),
    ref_name: RefNameV2Schema,
    previous_version: DigestHexSchema.nullable(),
    current_version: DigestHexSchema,
  }),
])
export type RefUpdateResultV2 = z.infer<typeof RefUpdateResultV2Schema>

export const IngestResultV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema,
    manifest: DatasetManifestV2Schema,
    ref_update: RefUpdateResultV2Schema,
  })
  .superRefine((result, context) => {
    if (result.manifest.dataset_version !== result.dataset_version) {
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'dataset_version'],
        message: 'manifest dataset version must match the ingest result',
      })
    }
    if (
      result.ref_update.status === 'updated' &&
      result.ref_update.current_version !== result.dataset_version
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref_update', 'current_version'],
        message: 'updated ref must point to the ingested dataset version',
      })
    }
  })
  .meta({ id: 'IngestResultV2' })
export type IngestResultV2 = z.infer<typeof IngestResultV2Schema>

export const DatasetViewV2Schema = z
  .strictObject({
    requested_ref: RefOrVersionV2Schema,
    ref_name: RefNameV2Schema.nullable(),
    dataset_version: DigestHexSchema,
    manifest: DatasetManifestV2Schema,
  })
  .superRefine((view, context) => {
    if (view.manifest.dataset_version !== view.dataset_version) {
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'dataset_version'],
        message: 'manifest dataset version must match the view',
      })
    }
    if (DigestHexSchema.safeParse(view.requested_ref).success) {
      if (view.requested_ref !== view.dataset_version || view.ref_name !== null) {
        context.addIssue({
          code: 'custom',
          path: ['requested_ref'],
          message: 'exact-version views cannot report a ref name',
        })
      }
    } else if (view.ref_name !== view.requested_ref) {
      context.addIssue({
        code: 'custom',
        path: ['ref_name'],
        message: 'resolved ref name must match requested_ref',
      })
    }
  })
  .meta({ id: 'DatasetViewV2' })
export type DatasetViewV2 = z.infer<typeof DatasetViewV2Schema>

export const RecordPageV2Schema = z
  .strictObject({
    items: z.array(RecordSummaryV2Schema).max(V2_RECORD_PAGE_MAX_LIMIT),
    offset: NonNegativeSafeIntegerSchema,
    limit: z.number().int().safe().min(1).max(V2_RECORD_PAGE_MAX_LIMIT),
    total: NonNegativeSafeIntegerSchema,
    dataset_version: DigestHexSchema,
  })
  .superRefine((page, context) => {
    if (page.items.length > page.limit) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'items cannot exceed limit' })
    }
    const expectedLength = Math.min(page.limit, Math.max(0, page.total - page.offset))
    if (page.items.length !== expectedLength) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'items length must match the requested page window',
      })
    }
    const recordIds = new Set<string>()
    for (let index = 0; index < page.items.length; index += 1) {
      const item = page.items[index]
      if (!item) continue
      if (recordIds.has(item.record_id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'record_id'],
          message: 'record IDs must be unique within a page',
        })
      }
      recordIds.add(item.record_id)
      const previous = page.items[index - 1]
      if (previous && compareRecordSummaryIdentity(previous, item) >= 0) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'record page items must be strictly digest/ID sorted',
        })
      }
    }
  })
  .meta({ id: 'RecordPageV2' })
export type RecordPageV2 = z.infer<typeof RecordPageV2Schema>

export const RecordViewV2Schema = z
  .strictObject({
    record: PostTrainingRecordV2Schema,
    record_digest: DigestHexSchema,
    eligibility: RecordEligibilityV2Schema,
    dataset_version: DigestHexSchema,
  })
  .superRefine((view, context) => {
    if (hashV2Record(view.record) !== view.record_digest) {
      context.addIssue({
        code: 'custom',
        path: ['record_digest'],
        message: 'record_digest must match record',
      })
    }
    const expectedEligibility = deriveRecordEligibilityV2(view.record)
    if (canonicalJsonV2(expectedEligibility) !== canonicalJsonV2(view.eligibility)) {
      context.addIssue({
        code: 'custom',
        path: ['eligibility'],
        message: 'eligibility must match the canonical record policy',
      })
    }
  })
  .meta({ id: 'RecordViewV2' })
export type RecordViewV2 = z.infer<typeof RecordViewV2Schema>

const AuditChecksV2Schema = z.strictObject({
  manifest: z.literal('ok'),
  artifact_digest: z.literal('ok'),
  parquet_schema: z.literal('ok'),
  record_digests: z.literal('ok'),
  dataset_version: z.literal('ok'),
})

export const AuditResultV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema,
    layout_version: z.literal('record-json-v1'),
    artifact_digest: DigestHexSchema,
    artifact_size_bytes: NonNegativeSafeIntegerSchema,
    checks: AuditChecksV2Schema,
  })
  .meta({ id: 'AuditResultV2' })
export type AuditResultV2 = z.infer<typeof AuditResultV2Schema>

export const OpaqueCursorQueryV2Schema = z
  .string()
  .max(V2_CURSOR_MAX_CHARS)
  .nullable()
  .overwrite((value) => (value === '' ? null : value))
  .default(null)

export const CursorPageRequestV2Schema = z
  .strictObject({
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_CURSOR_PAGE_MAX_LIMIT)
      .default(V2_CURSOR_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'CursorPageRequestV2' })
export type CursorPageRequestV2 = z.infer<typeof CursorPageRequestV2Schema>

export const RecordPageRequestV2Schema = z
  .strictObject({
    offset: z.coerce.number().int().safe().min(0).default(0),
    limit: z.coerce.number().int().safe().min(1).max(V2_RECORD_PAGE_MAX_LIMIT).default(20),
  })
  .meta({ id: 'RecordPageRequestV2' })
export type RecordPageRequestV2 = z.infer<typeof RecordPageRequestV2Schema>

export const RefMetadataV2Schema = z
  .strictObject({
    name: RefNameV2Schema,
    version: DigestHexSchema,
    num_records: z.number().int().safe().min(0),
    message: z.string().nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'RefMetadataV2' })
export type RefMetadataV2 = z.infer<typeof RefMetadataV2Schema>

export const DeletedRefMetadataV2Schema = RefMetadataV2Schema.extend({
  deleted_at: Rfc3339UtcSchema,
})
  .strict()
  .meta({ id: 'DeletedRefMetadataV2' })
export type DeletedRefMetadataV2 = z.infer<typeof DeletedRefMetadataV2Schema>

export const RefPageV2Schema = z
  .strictObject({
    items: z.array(RefMetadataV2Schema).max(V2_CURSOR_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(V2_CURSOR_MAX_CHARS).nullable(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1]
      const current = page.items[index]
      if (previous && current && previous.name >= current.name) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'name'],
          message: 'ref page items must be strictly C/ASCII sorted and unique',
        })
      }
    }
  })
  .meta({ id: 'RefPageV2' })
export type RefPageV2 = z.infer<typeof RefPageV2Schema>

export const DeletedRefPageV2Schema = z
  .strictObject({
    items: z.array(DeletedRefMetadataV2Schema).max(V2_CURSOR_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(V2_CURSOR_MAX_CHARS).nullable(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1]
      const current = page.items[index]
      if (previous && current && previous.name >= current.name) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'name'],
          message: 'deleted ref page items must be strictly C/ASCII sorted and unique',
        })
      }
    }
  })
  .meta({ id: 'DeletedRefPageV2' })
export type DeletedRefPageV2 = z.infer<typeof DeletedRefPageV2Schema>

export const PutRefRequestV2Schema = z
  .strictObject({
    new_version: DigestHexSchema,
    expected_version: DigestHexSchema.nullable(),
    message: z.string().min(1).nullable(),
  })
  .meta({ id: 'PutRefRequestV2' })
export type PutRefRequestV2 = z.infer<typeof PutRefRequestV2Schema>

export const DeleteRefRequestV2Schema = z
  .strictObject({
    expected_version: DigestHexSchema,
  })
  .meta({ id: 'DeleteRefRequestV2' })
export type DeleteRefRequestV2 = z.infer<typeof DeleteRefRequestV2Schema>

export const RestoreRefRequestV2Schema = z
  .strictObject({
    expected_version: DigestHexSchema,
  })
  .meta({ id: 'RestoreRefRequestV2' })
export type RestoreRefRequestV2 = z.infer<typeof RestoreRefRequestV2Schema>

export const DeleteRefResultV2Schema = z
  .strictObject({
    status: z.enum(['deleted', 'already_deleted']),
    ref: DeletedRefMetadataV2Schema,
  })
  .meta({ id: 'DeleteRefResultV2' })
export type DeleteRefResultV2 = z.infer<typeof DeleteRefResultV2Schema>

export const RestoreRefResultV2Schema = z
  .strictObject({
    status: z.enum(['restored', 'already_active']),
    ref: RefMetadataV2Schema,
  })
  .meta({ id: 'RestoreRefResultV2' })
export type RestoreRefResultV2 = z.infer<typeof RestoreRefResultV2Schema>

export const RefConflictDetailV2Schema = z
  .strictObject({
    ref_name: RefNameV2Schema,
    expected_version: DigestHexSchema.nullable(),
    current_version: DigestHexSchema.nullable(),
    new_version: DigestHexSchema,
    new_dataset_committed: z.boolean(),
  })
  .meta({ id: 'RefConflictDetailV2' })
export type RefConflictDetailV2 = z.infer<typeof RefConflictDetailV2Schema>

export const RefStateConflictDetailV2Schema = z
  .strictObject({
    ref_name: RefNameV2Schema,
    expected_version: DigestHexSchema,
    current_version: DigestHexSchema,
    current_state: z.enum(['active', 'deleted']),
    operation: z.enum(['delete', 'restore']),
  })
  .meta({ id: 'RefStateConflictDetailV2' })
export type RefStateConflictDetailV2 = z.infer<typeof RefStateConflictDetailV2Schema>

const ErrorMessageV2Schema = z.string().min(1).max(2_048)
const ErrorReasonV2Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/)
const ErrorResourceV2Schema = ErrorReasonV2Schema
const DecimalQuantityV2Schema = z.union([
  NonNegativeSafeIntegerSchema,
  z
    .string()
    .max(64)
    .regex(/^(?:0|[1-9][0-9]*)$/),
])

export const ValidationIssueV2Schema = z
  .strictObject({
    path: z.string().max(1_024),
    line: z.number().int().safe().positive().nullable(),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9._-]*$/),
    message: ErrorMessageV2Schema,
  })
  .meta({ id: 'ValidationIssueV2' })
export type ValidationIssueV2 = z.infer<typeof ValidationIssueV2Schema>

const ValidationIssuesV2Schema = z.array(ValidationIssueV2Schema).min(1).max(1_024)

export const BadRequestDetailV2Schema = z
  .strictObject({ issues: ValidationIssuesV2Schema })
  .meta({ id: 'BadRequestDetailV2' })
export type BadRequestDetailV2 = z.infer<typeof BadRequestDetailV2Schema>

export const ValidationErrorDetailV2Schema = z
  .strictObject({ issues: ValidationIssuesV2Schema })
  .meta({ id: 'ValidationErrorDetailV2' })
export type ValidationErrorDetailV2 = z.infer<typeof ValidationErrorDetailV2Schema>

export const ResourceLimitDetailV2Schema = z
  .strictObject({
    resource: ErrorResourceV2Schema,
    limit: NonNegativeSafeIntegerSchema,
    actual: DecimalQuantityV2Schema,
    issues: ValidationIssuesV2Schema.optional(),
  })
  .meta({ id: 'ResourceLimitDetailV2' })
export type ResourceLimitDetailV2 = z.infer<typeof ResourceLimitDetailV2Schema>

export const CapacityExceededDetailV2Schema = z
  .union([
    z.strictObject({
      resource: ErrorResourceV2Schema,
      limit: DecimalQuantityV2Schema,
      actual: DecimalQuantityV2Schema,
    }),
    z.strictObject({
      resource: ErrorResourceV2Schema,
      required: DecimalQuantityV2Schema,
      available: DecimalQuantityV2Schema,
    }),
  ])
  .meta({ id: 'CapacityExceededDetailV2' })
export type CapacityExceededDetailV2 = z.infer<typeof CapacityExceededDetailV2Schema>

export const NotFoundDetailV2Schema = z
  .strictObject({
    kind: z.enum(['route', 'ref', 'dataset', 'record', 'converter', 'transform', 'evaluation_run']),
    value: z.string().min(1).max(512),
  })
  .meta({ id: 'NotFoundDetailV2' })
export type NotFoundDetailV2 = z.infer<typeof NotFoundDetailV2Schema>

export const IdentityConflictDetailV2Schema = z
  .strictObject({
    reason: z.enum(['claim_request_mismatch', 'claim_identity_mismatch']),
  })
  .meta({ id: 'IdentityConflictDetailV2' })
export type IdentityConflictDetailV2 = z.infer<typeof IdentityConflictDetailV2Schema>

export const DeterminismConflictDetailV2Schema = z
  .strictObject({
    cache_key: DigestHexSchema,
    existing_output_version: DigestHexSchema,
    attempted_output_version: DigestHexSchema,
    attempted_dataset_committed: z.boolean(),
  })
  .meta({ id: 'DeterminismConflictDetailV2' })
export type DeterminismConflictDetailV2 = z.infer<typeof DeterminismConflictDetailV2Schema>

export const LayoutConflictDetailV2Schema = z
  .strictObject({ reason: z.literal('layout_conflict') })
  .meta({ id: 'LayoutConflictDetailV2' })
export type LayoutConflictDetailV2 = z.infer<typeof LayoutConflictDetailV2Schema>

export const UnsupportedProfileDetailV2Schema = z
  .strictObject({
    kind: z.enum(['identity', 'record_schema', 'layout', 'export_fidelity']),
    value: z.string().min(1).max(128),
    supported: z.array(z.string().min(1).max(128)).max(64),
  })
  .superRefine((detail, context) => {
    if (new Set(detail.supported).size !== detail.supported.length) {
      context.addIssue({
        code: 'custom',
        path: ['supported'],
        message: 'supported profile values must be unique',
      })
    }
  })
  .meta({ id: 'UnsupportedProfileDetailV2' })
export type UnsupportedProfileDetailV2 = z.infer<typeof UnsupportedProfileDetailV2Schema>

export const IntegrityErrorDetailV2Schema = z
  .strictObject({
    reason: ErrorReasonV2Schema,
    dataset_version: DigestHexSchema.optional(),
    layout_version: z.string().min(1).max(128).optional(),
  })
  .meta({ id: 'IntegrityErrorDetailV2' })
export type IntegrityErrorDetailV2 = z.infer<typeof IntegrityErrorDetailV2Schema>

export const UnauthorizedDetailV2Schema = z
  .strictObject({ reason: z.enum(['credentials_missing', 'credentials_invalid']) })
  .meta({ id: 'UnauthorizedDetailV2' })
export type UnauthorizedDetailV2 = z.infer<typeof UnauthorizedDetailV2Schema>

export const ForbiddenDetailV2Schema = z
  .strictObject({ reason: z.literal('workspace_access_denied') })
  .meta({ id: 'ForbiddenDetailV2' })
export type ForbiddenDetailV2 = z.infer<typeof ForbiddenDetailV2Schema>

export const TooManyRequestsDetailV2Schema = z
  .strictObject({ retry_after_seconds: NonNegativeSafeIntegerSchema.nullable() })
  .meta({ id: 'TooManyRequestsDetailV2' })
export type TooManyRequestsDetailV2 = z.infer<typeof TooManyRequestsDetailV2Schema>

export const ServiceUnavailableDetailV2Schema = z
  .strictObject({
    dependency: z.enum(['postgres', 'object_store', 'worker', 'unknown']),
    retryable: z.literal(true),
  })
  .meta({ id: 'ServiceUnavailableDetailV2' })
export type ServiceUnavailableDetailV2 = z.infer<typeof ServiceUnavailableDetailV2Schema>

export const InternalErrorDetailV2Schema = z
  .strictObject({ reason: z.literal('unexpected_error') })
  .meta({ id: 'InternalErrorDetailV2' })
export type InternalErrorDetailV2 = z.infer<typeof InternalErrorDetailV2Schema>

const BadRequestErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'bad_request',
  BadRequestDetailV2Schema,
)
const ValidationErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'validation_error',
  ValidationErrorDetailV2Schema,
)
const ResourceLimitErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'resource_limit',
  ResourceLimitDetailV2Schema,
)
const CapacityExceededErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'capacity_exceeded',
  CapacityExceededDetailV2Schema,
)
const NotFoundErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'not_found',
  NotFoundDetailV2Schema,
)
const IdentityConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'identity_conflict',
  IdentityConflictDetailV2Schema,
)
const DeterminismConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'determinism_conflict',
  DeterminismConflictDetailV2Schema,
)
const LayoutConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'layout_conflict',
  LayoutConflictDetailV2Schema,
)
const RefConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'ref_conflict',
  RefConflictDetailV2Schema,
)
const RefStateConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'ref_state_conflict',
  RefStateConflictDetailV2Schema,
)
const TransformJobStateConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'transform_job_state_conflict',
  TransformJobStateConflictDetailV2Schema,
)
const EvaluationRunStateConflictErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'evaluation_run_state_conflict',
  EvaluationRunStateConflictDetailV2Schema,
)
const UnsupportedProfileErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'unsupported_profile',
  UnsupportedProfileDetailV2Schema,
)
const FidelityErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'fidelity_error',
  FidelityErrorDetailV2Schema,
)
const IntegrityErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'integrity_error',
  IntegrityErrorDetailV2Schema,
)
const UnauthorizedErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'unauthorized',
  UnauthorizedDetailV2Schema,
)
const ForbiddenErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'forbidden',
  ForbiddenDetailV2Schema,
)
const TooManyRequestsErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'too_many_requests',
  TooManyRequestsDetailV2Schema,
)
const ServiceUnavailableErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'service_unavailable',
  ServiceUnavailableDetailV2Schema,
)
const InternalErrorBodyV2Schema = createDetailedErrorBodyV2Schema(
  'internal_error',
  InternalErrorDetailV2Schema,
)

export const ErrorBodyV2Schema = z
  .discriminatedUnion('code', [
    BadRequestErrorBodyV2Schema,
    ValidationErrorBodyV2Schema,
    ResourceLimitErrorBodyV2Schema,
    CapacityExceededErrorBodyV2Schema,
    NotFoundErrorBodyV2Schema,
    IdentityConflictErrorBodyV2Schema,
    DeterminismConflictErrorBodyV2Schema,
    LayoutConflictErrorBodyV2Schema,
    RefConflictErrorBodyV2Schema,
    RefStateConflictErrorBodyV2Schema,
    TransformJobStateConflictErrorBodyV2Schema,
    EvaluationRunStateConflictErrorBodyV2Schema,
    UnsupportedProfileErrorBodyV2Schema,
    FidelityErrorBodyV2Schema,
    IntegrityErrorBodyV2Schema,
    UnauthorizedErrorBodyV2Schema,
    ForbiddenErrorBodyV2Schema,
    TooManyRequestsErrorBodyV2Schema,
    ServiceUnavailableErrorBodyV2Schema,
    InternalErrorBodyV2Schema,
  ])
  .meta({ id: 'ErrorBodyV2' })
export type ErrorBodyV2 = z.infer<typeof ErrorBodyV2Schema>

export const ErrorResponseV2Schema = z
  .strictObject({ error: ErrorBodyV2Schema })
  .meta({ id: 'ErrorResponseV2' })
export type ErrorResponseV2 = z.infer<typeof ErrorResponseV2Schema>

export const BadRequestErrorResponseV2Schema = createErrorResponseV2Schema(
  'BadRequestErrorResponseV2',
  BadRequestErrorBodyV2Schema,
)
export type BadRequestErrorResponseV2 = z.infer<typeof BadRequestErrorResponseV2Schema>

export const ValidationErrorResponseV2Schema = createErrorResponseV2Schema(
  'ValidationErrorResponseV2',
  ValidationErrorBodyV2Schema,
)
export type ValidationErrorResponseV2 = z.infer<typeof ValidationErrorResponseV2Schema>

export const ResourceLimitErrorResponseV2Schema = createErrorResponseV2Schema(
  'ResourceLimitErrorResponseV2',
  ResourceLimitErrorBodyV2Schema,
)
export type ResourceLimitErrorResponseV2 = z.infer<typeof ResourceLimitErrorResponseV2Schema>

export const CapacityExceededErrorResponseV2Schema = createErrorResponseV2Schema(
  'CapacityExceededErrorResponseV2',
  CapacityExceededErrorBodyV2Schema,
)
export type CapacityExceededErrorResponseV2 = z.infer<typeof CapacityExceededErrorResponseV2Schema>

export const NotFoundErrorResponseV2Schema = createErrorResponseV2Schema(
  'NotFoundErrorResponseV2',
  NotFoundErrorBodyV2Schema,
)
export type NotFoundErrorResponseV2 = z.infer<typeof NotFoundErrorResponseV2Schema>

export const IdentityConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'IdentityConflictErrorResponseV2',
  IdentityConflictErrorBodyV2Schema,
)
export type IdentityConflictErrorResponseV2 = z.infer<typeof IdentityConflictErrorResponseV2Schema>

export const DeterminismConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'DeterminismConflictErrorResponseV2',
  DeterminismConflictErrorBodyV2Schema,
)
export type DeterminismConflictErrorResponseV2 = z.infer<
  typeof DeterminismConflictErrorResponseV2Schema
>

export const LayoutConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'LayoutConflictErrorResponseV2',
  LayoutConflictErrorBodyV2Schema,
)
export type LayoutConflictErrorResponseV2 = z.infer<typeof LayoutConflictErrorResponseV2Schema>

export const RefConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'RefConflictErrorResponseV2',
  RefConflictErrorBodyV2Schema,
)
export type RefConflictErrorResponseV2 = z.infer<typeof RefConflictErrorResponseV2Schema>

export const RefStateConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'RefStateConflictErrorResponseV2',
  RefStateConflictErrorBodyV2Schema,
)
export type RefStateConflictErrorResponseV2 = z.infer<typeof RefStateConflictErrorResponseV2Schema>

export const TransformJobStateConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'TransformJobStateConflictErrorResponseV2',
  TransformJobStateConflictErrorBodyV2Schema,
)
export type TransformJobStateConflictErrorResponseV2 = z.infer<
  typeof TransformJobStateConflictErrorResponseV2Schema
>

export const EvaluationRunStateConflictErrorResponseV2Schema = createErrorResponseV2Schema(
  'EvaluationRunStateConflictErrorResponseV2',
  EvaluationRunStateConflictErrorBodyV2Schema,
)
export type EvaluationRunStateConflictErrorResponseV2 = z.infer<
  typeof EvaluationRunStateConflictErrorResponseV2Schema
>

export const FidelityErrorResponseV2Schema = createErrorResponseV2Schema(
  'FidelityErrorResponseV2',
  FidelityErrorBodyV2Schema,
)
export type FidelityErrorResponseV2 = z.infer<typeof FidelityErrorResponseV2Schema>

export const UnsupportedProfileErrorResponseV2Schema = createErrorResponseV2Schema(
  'UnsupportedProfileErrorResponseV2',
  UnsupportedProfileErrorBodyV2Schema,
)
export type UnsupportedProfileErrorResponseV2 = z.infer<
  typeof UnsupportedProfileErrorResponseV2Schema
>

export const IntegrityErrorResponseV2Schema = createErrorResponseV2Schema(
  'IntegrityErrorResponseV2',
  IntegrityErrorBodyV2Schema,
)
export type IntegrityErrorResponseV2 = z.infer<typeof IntegrityErrorResponseV2Schema>

export const UnauthorizedErrorResponseV2Schema = createErrorResponseV2Schema(
  'UnauthorizedErrorResponseV2',
  UnauthorizedErrorBodyV2Schema,
)
export type UnauthorizedErrorResponseV2 = z.infer<typeof UnauthorizedErrorResponseV2Schema>

export const ForbiddenErrorResponseV2Schema = createErrorResponseV2Schema(
  'ForbiddenErrorResponseV2',
  ForbiddenErrorBodyV2Schema,
)
export type ForbiddenErrorResponseV2 = z.infer<typeof ForbiddenErrorResponseV2Schema>

export const TooManyRequestsErrorResponseV2Schema = createErrorResponseV2Schema(
  'TooManyRequestsErrorResponseV2',
  TooManyRequestsErrorBodyV2Schema,
)
export type TooManyRequestsErrorResponseV2 = z.infer<typeof TooManyRequestsErrorResponseV2Schema>

export const ServiceUnavailableErrorResponseV2Schema = createErrorResponseV2Schema(
  'ServiceUnavailableErrorResponseV2',
  ServiceUnavailableErrorBodyV2Schema,
)
export type ServiceUnavailableErrorResponseV2 = z.infer<
  typeof ServiceUnavailableErrorResponseV2Schema
>

export const InternalErrorResponseV2Schema = createErrorResponseV2Schema(
  'InternalErrorResponseV2',
  InternalErrorBodyV2Schema,
)
export type InternalErrorResponseV2 = z.infer<typeof InternalErrorResponseV2Schema>

export const ErrorResponse409V2Schema = z
  .union([
    IdentityConflictErrorResponseV2Schema,
    DeterminismConflictErrorResponseV2Schema,
    LayoutConflictErrorResponseV2Schema,
    RefConflictErrorResponseV2Schema,
    RefStateConflictErrorResponseV2Schema,
    TransformJobStateConflictErrorResponseV2Schema,
    EvaluationRunStateConflictErrorResponseV2Schema,
  ])
  .meta({ id: 'ErrorResponse409V2' })
export type ErrorResponse409V2 = z.infer<typeof ErrorResponse409V2Schema>

export const IngestConflictErrorResponseV2Schema = z
  .union([
    IdentityConflictErrorResponseV2Schema,
    LayoutConflictErrorResponseV2Schema,
    RefConflictErrorResponseV2Schema,
  ])
  .meta({ id: 'IngestConflictErrorResponseV2' })
export type IngestConflictErrorResponseV2 = z.infer<typeof IngestConflictErrorResponseV2Schema>

export const ValidationOrUnsupportedProfileErrorResponseV2Schema = z
  .union([ValidationErrorResponseV2Schema, UnsupportedProfileErrorResponseV2Schema])
  .meta({ id: 'ValidationOrUnsupportedProfileErrorResponseV2' })
export type ValidationOrUnsupportedProfileErrorResponseV2 = z.infer<
  typeof ValidationOrUnsupportedProfileErrorResponseV2Schema
>

export const ErrorResponse422V2Schema = z
  .union([
    ValidationErrorResponseV2Schema,
    UnsupportedProfileErrorResponseV2Schema,
    FidelityErrorResponseV2Schema,
  ])
  .meta({ id: 'ErrorResponse422V2' })
export type ErrorResponse422V2 = z.infer<typeof ErrorResponse422V2Schema>

export const ErrorResponse500V2Schema = z
  .union([IntegrityErrorResponseV2Schema, InternalErrorResponseV2Schema])
  .meta({ id: 'ErrorResponse500V2' })
export type ErrorResponse500V2 = z.infer<typeof ErrorResponse500V2Schema>

export const ErrorResponse503V2Schema = z
  .union([CapacityExceededErrorResponseV2Schema, ServiceUnavailableErrorResponseV2Schema])
  .meta({ id: 'ErrorResponse503V2' })
export type ErrorResponse503V2 = z.infer<typeof ErrorResponse503V2Schema>

export class RefConflictErrorV2 extends ConflictError {
  override readonly name = 'RefConflictErrorV2'
  override readonly code = 'ref_conflict'

  constructor(detailInput: RefConflictDetailV2) {
    const detail = Object.freeze(RefConflictDetailV2Schema.parse(detailInput))
    super(`V2 ref compare-and-set conflict for ${detail.ref_name}`, detail)
  }
}

export class RefStateConflictErrorV2 extends ConflictError {
  override readonly name = 'RefStateConflictErrorV2'
  override readonly code = 'ref_state_conflict'

  constructor(detailInput: RefStateConflictDetailV2) {
    const detail = Object.freeze(RefStateConflictDetailV2Schema.parse(detailInput))
    super(`V2 ref ${detail.operation} compare-and-set conflict for ${detail.ref_name}`, detail)
  }
}

export class TransformJobStateConflictErrorV2 extends ConflictError {
  override readonly name = 'TransformJobStateConflictErrorV2'
  override readonly code = 'transform_job_state_conflict'

  constructor(detailInput: TransformJobStateConflictDetailV2) {
    const detail = Object.freeze(TransformJobStateConflictDetailV2Schema.parse(detailInput))
    super(`V2 transform job state conflict for ${detail.job_id}`, detail)
  }
}

function compareRecordSummaryIdentity(
  left: z.infer<typeof RecordSummaryV2Schema>,
  right: z.infer<typeof RecordSummaryV2Schema>,
): number {
  if (left.record_digest !== right.record_digest) {
    return left.record_digest < right.record_digest ? -1 : 1
  }
  if (left.record_id === right.record_id) return 0
  return left.record_id < right.record_id ? -1 : 1
}

function createDetailedErrorBodyV2Schema<const Code extends string, Detail extends z.ZodType>(
  code: Code,
  detail: Detail,
) {
  return z.strictObject({
    code: z.literal(code),
    message: ErrorMessageV2Schema,
    detail,
  })
}

function createErrorResponseV2Schema<Body extends z.ZodType>(id: string, body: Body) {
  return z.strictObject({ error: body }).meta({ id })
}
