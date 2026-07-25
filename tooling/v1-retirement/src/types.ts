import { z } from 'zod'

export const V1_TABLE_NAMES = ['datasets', 'runs', 'refs', 'vocabularies', 'vocab_refs'] as const

export const V2_TABLE_NAMES = [
  'identity_namespaces_v2',
  'identity_claims_v2',
  'dataset_snapshots_v2',
  'dataset_layouts_v2',
  'runs_v2',
  'run_inputs_v2',
  'record_revision_locations_v2',
  'record_parent_edges_v2',
  'refs_v2',
] as const

export type V1TableName = (typeof V1_TABLE_NAMES)[number]
export type V2TableName = (typeof V2_TABLE_NAMES)[number]
export type ObjectStoreProvider = 'oss' | 's3'

const NonnegativeIntegerStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const ForeignKeySchema = z.strictObject({
  name: z.string().min(1),
  source_table: z.string().min(1),
  target_table: z.string().min(1),
  definition: z.string().min(1),
})
export type ForeignKey = z.infer<typeof ForeignKeySchema>

export const DatabaseTablePlanSchema = z.strictObject({
  name: z.enum(V1_TABLE_NAMES),
  exists: z.boolean(),
  row_count: NonnegativeIntegerStringSchema,
  rows_digest: DigestSchema,
  rows_md5: z.string().regex(/^[0-9a-f]{32}$/),
  total_bytes: NonnegativeIntegerStringSchema,
  foreign_keys: z.array(ForeignKeySchema),
})
export type DatabaseTablePlan = z.infer<typeof DatabaseTablePlanSchema>

export const DatabaseRetirementPlanSchema = z.strictObject({
  schema: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  tables: z.array(DatabaseTablePlanSchema).length(V1_TABLE_NAMES.length),
  total_rows: NonnegativeIntegerStringSchema,
  digest: DigestSchema,
})
export type DatabaseRetirementPlan = z.infer<typeof DatabaseRetirementPlanSchema>

export const ObjectMetadataSchema = z.strictObject({
  key: z.string().min(1),
  size: z.number().int().nonnegative().safe(),
  etag: z.string().min(1).nullable(),
})
export type ObjectMetadata = z.infer<typeof ObjectMetadataSchema>

export const LegacyObjectTargetSchema = ObjectMetadataSchema.extend({
  kind: z.enum(['dataset_manifest', 'dataset_parquet', 'vocabulary_json']),
})
export type LegacyObjectTarget = z.infer<typeof LegacyObjectTargetSchema>

export const ObjectRetirementPlanSchema = z.strictObject({
  provider: z.enum(['oss', 's3']),
  bucket: z.string().min(1),
  targets: z.array(LegacyObjectTargetSchema),
  target_count: z.number().int().nonnegative().safe(),
  target_bytes: z.number().int().nonnegative().safe(),
  unrecognized_legacy_prefix_objects: z.array(ObjectMetadataSchema),
  protected_v2_object_count: z.number().int().nonnegative().safe(),
  digest: DigestSchema,
})
export type ObjectRetirementPlan = z.infer<typeof ObjectRetirementPlanSchema>

export const V2CatalogFingerprintSchema = z.strictObject({
  table: z.enum(V2_TABLE_NAMES),
  row_count: NonnegativeIntegerStringSchema,
  rows_digest: DigestSchema,
})
export type V2CatalogFingerprint = z.infer<typeof V2CatalogFingerprintSchema>

export const V2AuditResultSchema = z.strictObject({
  dataset_version: DigestSchema,
  layout_version: z.string().min(1),
  artifact_digest: DigestSchema,
  artifact_size_bytes: z.number().int().nonnegative().safe(),
  checks: z.strictObject({
    manifest: z.literal('ok'),
    artifact_digest: z.literal('ok'),
    parquet_schema: z.literal('ok'),
    record_digests: z.literal('ok'),
    dataset_version: z.literal('ok'),
  }),
})
export type V2AuditResult = z.infer<typeof V2AuditResultSchema>

export const V2BaselineSchema = z.strictObject({
  catalog: z.array(V2CatalogFingerprintSchema).length(V2_TABLE_NAMES.length),
  objects: z.array(ObjectMetadataSchema),
  audits: z.array(V2AuditResultSchema),
  digest: DigestSchema,
})
export type V2Baseline = z.infer<typeof V2BaselineSchema>

export const RetirementManifestSchema = z.strictObject({
  manifest_version: z.literal('databench-v1-retirement-preflight-1'),
  database: DatabaseRetirementPlanSchema,
  objects: ObjectRetirementPlanSchema,
  v2_baseline: V2BaselineSchema,
})
export type RetirementManifest = z.infer<typeof RetirementManifestSchema>
