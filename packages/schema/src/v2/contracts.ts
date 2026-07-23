import { canonicalJsonV2, hashV2Record } from '@databench/hashing'
import { z } from 'zod'
import { ConflictError } from '../errors.js'
import { DigestHexSchema, NonNegativeSafeIntegerSchema, Rfc3339UtcSchema } from './common.js'
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
    items: z.array(RecordSummaryV2Schema),
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

export const CursorPageRequestV2Schema = z.strictObject({
  cursor: z.string().min(1).max(V2_CURSOR_MAX_CHARS).nullable(),
  limit: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(V2_CURSOR_PAGE_MAX_LIMIT)
    .default(V2_CURSOR_PAGE_DEFAULT_LIMIT),
})
export type CursorPageRequestV2 = z.infer<typeof CursorPageRequestV2Schema>

export const RecordPageRequestV2Schema = z.strictObject({
  offset: NonNegativeSafeIntegerSchema.default(0),
  limit: z.number().int().safe().min(1).max(V2_RECORD_PAGE_MAX_LIMIT).default(20),
})
export type RecordPageRequestV2 = z.infer<typeof RecordPageRequestV2Schema>

export const RefMetadataV2Schema = z
  .strictObject({
    name: RefNameV2Schema,
    version: DigestHexSchema,
    message: z.string().nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'RefMetadataV2' })
export type RefMetadataV2 = z.infer<typeof RefMetadataV2Schema>

export const RefPageV2Schema = z
  .strictObject({
    items: z.array(RefMetadataV2Schema),
    next_cursor: z.string().min(1).nullable(),
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

export const PutRefRequestV2Schema = z
  .strictObject({
    new_version: DigestHexSchema,
    expected_version: DigestHexSchema.nullable(),
    message: z.string().min(1).nullable(),
  })
  .meta({ id: 'PutRefRequestV2' })
export type PutRefRequestV2 = z.infer<typeof PutRefRequestV2Schema>

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

export class RefConflictErrorV2 extends ConflictError {
  override readonly name = 'RefConflictErrorV2'
  override readonly code = 'ref_conflict'

  constructor(detailInput: RefConflictDetailV2) {
    const detail = Object.freeze(RefConflictDetailV2Schema.parse(detailInput))
    super(`V2 ref compare-and-set conflict for ${detail.ref_name}`, detail)
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
