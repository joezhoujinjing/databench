import { z } from 'zod'
import { DigestHexSchema, NonNegativeSafeIntegerSchema, Rfc3339UtcSchema } from './common.js'
import { OpaqueCursorQueryV2Schema } from './contracts.js'
import {
  SwiftStudioProviderSessionIdV2Schema,
  SwiftStudioSessionIdV2Schema,
} from './swift-studio.js'

export const V2_MODEL_ARTIFACT_PAGE_DEFAULT_LIMIT = 20
export const V2_MODEL_ARTIFACT_PAGE_MAX_LIMIT = 100
export const V2_SWIFT_STUDIO_OUTPUT_MAX_ITEMS = 256
export const V2_MODEL_ARTIFACT_MANIFEST_MAX_BYTES = 256 * 1024
export const V2_MODEL_ARTIFACT_MANIFEST_MAX_FILES = 256

export const MODEL_ARTIFACT_MANIFEST_VERSION_V1 = 'model-artifact-manifest-v1' as const
export const MODEL_ARTIFACT_KIND_LORA_ADAPTER = 'lora_adapter' as const
export const MODEL_ARTIFACT_FORMAT_SWIFT_LORA_ADAPTER_V1 = 'swift-lora-adapter-v1' as const
export const MODEL_ARTIFACT_ARCHIVE_FORMAT_DETERMINISTIC_TAR_ZST_V1 =
  'deterministic-tar-zst-v1' as const

const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const OPAQUE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{15,511}$/
const PROVIDER_IMPORT_ID = /^swai_[A-Za-z0-9_-]{16,128}$/
const PROVIDER_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const GIT_COMMIT = /^[0-9a-f]{40}$/
const MODEL_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,255}$/
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|(?:\.\.?)[\\/]|(?:~)[\\/])/i
const WINDOWS_SEPARATOR = /\\/
const MODEL_ARTIFACT_OBJECT_KEY =
  /^objects\/v2\/model-artifact-v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.tar\.zst$/
const SWIFT_ARTIFACT_STAGING_KEY = /^staging\/swift-artifact\/v1\/[0-9a-f-]{36}\/archive\.tar\.zst$/
const ALLOWED_ADAPTER_FILE =
  /^(?:additional_config\.json|adapter_config\.json|adapter_model\.safetensors|adapter_model-\d{5}-of-\d{5}\.safetensors|adapter_model\.safetensors\.index\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|added_tokens\.json|merges\.txt|vocab\.json|preprocessor_config\.json|processor_config\.json|chat_template\.json)$/
const encoder = new TextEncoder()

function utf8BoundedSanitizedString(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, {
      message: `Expected at most ${maxBytes} UTF-8 bytes`,
    })
    .refine(
      (value) => {
        for (let index = 0; index < value.length; index += 1) {
          const codeUnit = value.charCodeAt(index)
          if (codeUnit <= 0x1f || codeUnit === 0x7f) return false
        }
        return true
      },
      { message: 'Control characters are not allowed' },
    )
    .refine((value) => !CREDENTIAL_VALUE.test(value), {
      message: 'Credential-like values are not allowed',
    })
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= maxBytes
  } catch {
    return false
  }
}

function compareAscii(left: string, right: string): number {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

export const ModelArtifactKindV2Schema = z.literal(MODEL_ARTIFACT_KIND_LORA_ADAPTER)
export type ModelArtifactKindV2 = z.infer<typeof ModelArtifactKindV2Schema>

export const ModelArtifactFormatV2Schema = z.literal(MODEL_ARTIFACT_FORMAT_SWIFT_LORA_ADAPTER_V1)
export type ModelArtifactFormatV2 = z.infer<typeof ModelArtifactFormatV2Schema>

export const ModelArtifactArchiveFormatV2Schema = z.literal(
  MODEL_ARTIFACT_ARCHIVE_FORMAT_DETERMINISTIC_TAR_ZST_V1,
)
export type ModelArtifactArchiveFormatV2 = z.infer<typeof ModelArtifactArchiveFormatV2Schema>

export const ModelArtifactDatasetLineageStatusV2Schema = z.enum([
  'verified',
  'external_or_unverified',
  'not_applicable',
])
export type ModelArtifactDatasetLineageStatusV2 = z.infer<
  typeof ModelArtifactDatasetLineageStatusV2Schema
>

export const ModelArtifactBaseModelBindingStatusV2Schema = z.enum([
  'verified',
  'declared',
  'unresolved',
])
export type ModelArtifactBaseModelBindingStatusV2 = z.infer<
  typeof ModelArtifactBaseModelBindingStatusV2Schema
>

export const ModelArtifactImportStatusV2Schema = z.enum([
  'requested',
  'staging',
  'finalizing',
  'completed',
  'failed',
])
export type ModelArtifactImportStatusV2 = z.infer<typeof ModelArtifactImportStatusV2Schema>

export const ModelArtifactIdV2Schema = z.uuid()
export const ModelArtifactImportIdV2Schema = z.uuid()

export const SwiftStudioOutputHandleV2Schema = z
  .string()
  .regex(OPAQUE_HANDLE)
  .refine((value) => encoder.encode(value).byteLength <= 512, {
    message: 'Output handle must not exceed 512 UTF-8 bytes',
  })
  .refine((value) => !ABSOLUTE_PATH.test(value) && !WINDOWS_SEPARATOR.test(value), {
    message: 'Output handle must be opaque and cannot be a path',
  })

export const SwiftStudioProviderGenerationV2Schema = z.string().regex(PROVIDER_GENERATION)
export const SwiftStudioProviderArtifactImportIdV2Schema = z.string().regex(PROVIDER_IMPORT_ID)

export const ModelArtifactDisplayNameV2Schema = utf8BoundedSanitizedString(256).refine(
  (value) => !ABSOLUTE_PATH.test(value),
  { message: 'Display name cannot be an absolute path' },
)

export const ModelArtifactBaseModelReferenceV2Schema = utf8BoundedSanitizedString(512).refine(
  (value) => !ABSOLUTE_PATH.test(value) && !WINDOWS_SEPARATOR.test(value),
  { message: 'Base model reference cannot be a local or absolute path' },
)

export const ModelArtifactBaseModelRevisionV2Schema = z
  .string()
  .regex(MODEL_REVISION)
  .refine((value) => encoder.encode(value).byteLength <= 256, {
    message: 'Base model revision must not exceed 256 UTF-8 bytes',
  })
  .refine((value) => !CREDENTIAL_VALUE.test(value) && !ABSOLUTE_PATH.test(value), {
    message: 'Base model revision cannot contain credentials or paths',
  })

export const ModelArtifactBaseModelRequestV2Schema = z
  .strictObject({
    reference: ModelArtifactBaseModelReferenceV2Schema,
    revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
  })
  .meta({ id: 'ModelArtifactBaseModelRequestV2' })
export type ModelArtifactBaseModelRequestV2 = z.infer<typeof ModelArtifactBaseModelRequestV2Schema>

export const ModelArtifactBaseModelV2Schema = ModelArtifactBaseModelRequestV2Schema.extend({
  binding_status: ModelArtifactBaseModelBindingStatusV2Schema,
})
  .superRefine((baseModel, context) => {
    if (baseModel.binding_status === 'verified' && baseModel.revision === null) {
      context.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'A verified base-model binding requires an exact revision',
      })
    }
  })
  .meta({ id: 'ModelArtifactBaseModelV2' })
export type ModelArtifactBaseModelV2 = z.infer<typeof ModelArtifactBaseModelV2Schema>

export const SwiftStudioOutputCandidateV2Schema = z
  .strictObject({
    handle: SwiftStudioOutputHandleV2Schema.nullable(),
    display_name: ModelArtifactDisplayNameV2Schema,
    candidate_kinds: z
      .array(ModelArtifactKindV2Schema)
      .max(1)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Candidate kinds must be unique',
      }),
    size_bytes: NonNegativeSafeIntegerSchema,
    modified_at: Rfc3339UtcSchema,
    importable: z.boolean(),
    reason: utf8BoundedSanitizedString(512).nullable(),
  })
  .superRefine((candidate, context) => {
    if (candidate.importable === (candidate.reason !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Only non-importable output candidates expose a reason',
      })
    }
    if (
      candidate.importable !== (candidate.handle !== null && candidate.candidate_kinds.length === 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['handle'],
        message: 'Only importable candidates expose an opaque handle and candidate kind',
      })
    }
  })
  .meta({ id: 'SwiftStudioOutputCandidateV2' })
export type SwiftStudioOutputCandidateV2 = z.infer<typeof SwiftStudioOutputCandidateV2Schema>

export const SwiftStudioOutputCandidatePageV2Schema = z
  .strictObject({
    items: z.array(SwiftStudioOutputCandidateV2Schema).max(V2_SWIFT_STUDIO_OUTPUT_MAX_ITEMS),
  })
  .meta({ id: 'SwiftStudioOutputCandidatePageV2' })
export type SwiftStudioOutputCandidatePageV2 = z.infer<
  typeof SwiftStudioOutputCandidatePageV2Schema
>

export const CreateModelArtifactImportRequestV2Schema = z
  .strictObject({
    studio_session_id: SwiftStudioSessionIdV2Schema,
    output_handle: SwiftStudioOutputHandleV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    display_name: ModelArtifactDisplayNameV2Schema,
    base_model: ModelArtifactBaseModelRequestV2Schema,
  })
  .meta({ id: 'CreateModelArtifactImportRequestV2' })
export type CreateModelArtifactImportRequestV2 = z.infer<
  typeof CreateModelArtifactImportRequestV2Schema
>

export const ModelArtifactImportParamsV2Schema = z
  .strictObject({ import_id: ModelArtifactImportIdV2Schema })
  .meta({ id: 'ModelArtifactImportParamsV2' })

export const ModelArtifactParamsV2Schema = z
  .strictObject({ artifact_id: ModelArtifactIdV2Schema })
  .meta({ id: 'ModelArtifactParamsV2' })

export const SwiftStudioSessionOutputsParamsV2Schema = z
  .strictObject({ session_id: SwiftStudioSessionIdV2Schema })
  .meta({ id: 'SwiftStudioSessionOutputsParamsV2' })

export const ModelArtifactImportFailureV2Schema = z
  .strictObject({
    phase: z.string().regex(SAFE_TOKEN),
    code: z.string().regex(SAFE_TOKEN),
    message: utf8BoundedSanitizedString(2_048),
  })
  .meta({ id: 'ModelArtifactImportFailureV2' })
export type ModelArtifactImportFailureV2 = z.infer<typeof ModelArtifactImportFailureV2Schema>

export const ModelArtifactManifestFileV2Schema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .max(128)
      .regex(ALLOWED_ADAPTER_FILE)
      .refine((value) => encoder.encode(value).byteLength <= 512, {
        message: 'Manifest file path must not exceed 512 UTF-8 bytes',
      }),
    digest: DigestHexSchema,
    size_bytes: NonNegativeSafeIntegerSchema,
  })
  .meta({ id: 'ModelArtifactManifestFileV2' })
export type ModelArtifactManifestFileV2 = z.infer<typeof ModelArtifactManifestFileV2Schema>

export const ModelArtifactDatasetLineageV2Schema = z
  .strictObject({
    status: ModelArtifactDatasetLineageStatusV2Schema,
    dataset_version: DigestHexSchema.nullable(),
    dataset_export_digest: DigestHexSchema.nullable(),
  })
  .superRefine((lineage, context) => {
    const hasExactDataset =
      lineage.dataset_version !== null && lineage.dataset_export_digest !== null
    if ((lineage.dataset_version === null) !== (lineage.dataset_export_digest === null)) {
      context.addIssue({
        code: 'custom',
        path: ['dataset_version'],
        message: 'Dataset version and export digest must be both null or both present',
      })
    }
    if ((lineage.status === 'verified') !== hasExactDataset) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Only verified lineage can bind an exact Dataset export',
      })
    }
  })
  .meta({ id: 'ModelArtifactDatasetLineageV2' })
export type ModelArtifactDatasetLineageV2 = z.infer<typeof ModelArtifactDatasetLineageV2Schema>

export const ModelArtifactTrainingSummaryV2Schema = z
  .strictObject({
    train_stage: z.string().regex(SAFE_TOKEN).nullable(),
    tuner_type: z.literal('lora'),
    lora_rank: z.number().int().safe().positive().max(65_536).nullable(),
    lora_alpha: z.number().finite().nonnegative().max(1_000_000).nullable(),
    lora_dropout: z.number().finite().min(0).max(1).nullable(),
    num_train_epochs: z.number().finite().positive().max(1_000_000).nullable(),
    max_steps: z.number().int().safe().positive().nullable(),
    learning_rate: z.number().finite().positive().max(1).nullable(),
    max_length: z.number().int().safe().positive().nullable(),
    dtype: z.string().regex(SAFE_TOKEN).nullable(),
    seed: z.number().int().safe().nullable(),
    redacted_fields_count: z.number().int().safe().nonnegative().max(100_000),
  })
  .meta({ id: 'ModelArtifactTrainingSummaryV2' })
export type ModelArtifactTrainingSummaryV2 = z.infer<typeof ModelArtifactTrainingSummaryV2Schema>

export const ModelArtifactManifestV2Schema = z
  .strictObject({
    manifest_version: z.literal(MODEL_ARTIFACT_MANIFEST_VERSION_V1),
    artifact_kind: ModelArtifactKindV2Schema,
    artifact_format: ModelArtifactFormatV2Schema,
    archive_format: ModelArtifactArchiveFormatV2Schema,
    archive_digest: DigestHexSchema,
    archive_size_bytes: NonNegativeSafeIntegerSchema,
    output_snapshot_digest: DigestHexSchema,
    files: z
      .array(ModelArtifactManifestFileV2Schema)
      .min(2)
      .max(V2_MODEL_ARTIFACT_MANIFEST_MAX_FILES),
    source: z.strictObject({
      studio_session_id: SwiftStudioSessionIdV2Schema,
      upstream_commit: z.string().regex(GIT_COMMIT),
      image_digest: DigestHexSchema,
    }),
    dataset_lineage: ModelArtifactDatasetLineageV2Schema,
    base_model: ModelArtifactBaseModelV2Schema,
    training_summary: ModelArtifactTrainingSummaryV2Schema,
    created_at: Rfc3339UtcSchema,
    created_by: z.literal('databench'),
  })
  .superRefine((manifest, context) => {
    if (!isBoundedJson(manifest, V2_MODEL_ARTIFACT_MANIFEST_MAX_BYTES)) {
      context.addIssue({
        code: 'custom',
        message: `Manifest exceeds ${V2_MODEL_ARTIFACT_MANIFEST_MAX_BYTES} UTF-8 bytes`,
      })
    }
    const paths = manifest.files.map((file) => file.path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', path: ['files'], message: 'File paths must be unique' })
    }
    const sortedPaths = [...paths].sort(compareAscii)
    if (paths.some((path, index) => path !== sortedPaths[index])) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Files must use deterministic ASCII path order',
      })
    }
    if (!paths.includes('adapter_config.json')) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'LoRA Adapter manifest requires adapter_config.json',
      })
    }
    const hasSingleModel = paths.includes('adapter_model.safetensors')
    const hasIndex = paths.includes('adapter_model.safetensors.index.json')
    const hasShards = paths.some((path) =>
      /^adapter_model-\d{5}-of-\d{5}\.safetensors$/u.test(path),
    )
    if (hasSingleModel === (hasIndex && hasShards)) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'LoRA Adapter requires one safetensors file or an index with shards',
      })
    }
    if (hasShards !== hasIndex) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Sharded safetensors require an index and indexed shards',
      })
    }
  })
  .meta({ id: 'ModelArtifactManifestV2' })
export type ModelArtifactManifestV2 = z.infer<typeof ModelArtifactManifestV2Schema>

export const ModelArtifactImportV2Schema = z
  .strictObject({
    id: ModelArtifactImportIdV2Schema,
    create_digest: DigestHexSchema,
    status: ModelArtifactImportStatusV2Schema,
    studio_session_id: SwiftStudioSessionIdV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    display_name: ModelArtifactDisplayNameV2Schema,
    base_model: ModelArtifactBaseModelRequestV2Schema,
    output_snapshot_digest: DigestHexSchema.nullable(),
    archive_digest: DigestHexSchema.nullable(),
    archive_size_bytes: NonNegativeSafeIntegerSchema.nullable(),
    manifest_digest: DigestHexSchema.nullable(),
    artifact_id: ModelArtifactIdV2Schema.nullable(),
    failure: ModelArtifactImportFailureV2Schema.nullable(),
    created_at: Rfc3339UtcSchema,
    staging_at: Rfc3339UtcSchema.nullable(),
    finalizing_at: Rfc3339UtcSchema.nullable(),
    completed_at: Rfc3339UtcSchema.nullable(),
    failed_at: Rfc3339UtcSchema.nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .superRefine((artifactImport, context) => {
    const requiresStaging =
      artifactImport.status === 'staging' ||
      artifactImport.status === 'finalizing' ||
      artifactImport.status === 'completed'
    const hasStaging = artifactImport.staging_at !== null
    if ((requiresStaging && !hasStaging) || (artifactImport.status === 'requested' && hasStaging)) {
      context.addIssue({
        code: 'custom',
        path: ['staging_at'],
        message: 'Staging and later imports require staging_at',
      })
    }
    const hasSnapshot = artifactImport.output_snapshot_digest !== null
    if (hasStaging !== hasSnapshot) {
      context.addIssue({
        code: 'custom',
        path: ['output_snapshot_digest'],
        message: 'staging_at and output snapshot digest must be both null or both present',
      })
    }
    const finalizationFields = [
      artifactImport.archive_digest,
      artifactImport.archive_size_bytes,
      artifactImport.manifest_digest,
      artifactImport.finalizing_at,
    ]
    const requiresFinalization =
      artifactImport.status === 'finalizing' || artifactImport.status === 'completed'
    const hasFinalization = finalizationFields.every((value) => value !== null)
    const hasAnyFinalization = finalizationFields.some((value) => value !== null)
    if (
      (requiresFinalization && !hasFinalization) ||
      (artifactImport.status !== 'failed' && !requiresFinalization && hasAnyFinalization) ||
      (artifactImport.status === 'failed' && hasAnyFinalization && !hasFinalization)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finalizing_at'],
        message: 'Immutable finalization metadata must be all null or all present',
      })
    }
    if ((artifactImport.status === 'completed') !== (artifactImport.artifact_id !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['artifact_id'],
        message: 'Only completed imports expose a Model Artifact ID',
      })
    }
    if ((artifactImport.status === 'completed') !== (artifactImport.completed_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['completed_at'],
        message: 'Only completed imports expose completed_at',
      })
    }
    if ((artifactImport.status === 'failed') !== (artifactImport.failure !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only failed imports expose a failure summary',
      })
    }
    if ((artifactImport.status === 'failed') !== (artifactImport.failed_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failed_at'],
        message: 'Only failed imports expose failed_at',
      })
    }
  })
  .meta({ id: 'ModelArtifactImportV2' })
export type ModelArtifactImportV2 = z.infer<typeof ModelArtifactImportV2Schema>

export const ModelArtifactV2Schema = z
  .strictObject({
    id: ModelArtifactIdV2Schema,
    display_name: ModelArtifactDisplayNameV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    artifact_format: ModelArtifactFormatV2Schema,
    archive_format: ModelArtifactArchiveFormatV2Schema,
    archive_digest: DigestHexSchema,
    archive_size_bytes: NonNegativeSafeIntegerSchema,
    manifest_digest: DigestHexSchema,
    manifest: ModelArtifactManifestV2Schema,
    source: z.strictObject({
      studio_session_id: SwiftStudioSessionIdV2Schema,
      import_id: ModelArtifactImportIdV2Schema,
    }),
    dataset_lineage: ModelArtifactDatasetLineageV2Schema,
    base_model: ModelArtifactBaseModelV2Schema,
    upstream_commit: z.string().regex(GIT_COMMIT),
    image_digest: DigestHexSchema,
    created_at: Rfc3339UtcSchema,
  })
  .superRefine((artifact, context) => {
    if (
      artifact.manifest.artifact_kind !== artifact.artifact_kind ||
      artifact.manifest.artifact_format !== artifact.artifact_format ||
      artifact.manifest.archive_format !== artifact.archive_format ||
      artifact.manifest.archive_digest !== artifact.archive_digest ||
      artifact.manifest.archive_size_bytes !== artifact.archive_size_bytes ||
      artifact.manifest.source.studio_session_id !== artifact.source.studio_session_id ||
      artifact.manifest.source.upstream_commit !== artifact.upstream_commit ||
      artifact.manifest.source.image_digest !== artifact.image_digest ||
      JSON.stringify(artifact.manifest.dataset_lineage) !==
        JSON.stringify(artifact.dataset_lineage) ||
      JSON.stringify(artifact.manifest.base_model) !== JSON.stringify(artifact.base_model)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'Stored manifest must match immutable Model Artifact metadata',
      })
    }
  })
  .meta({ id: 'ModelArtifactV2' })
export type ModelArtifactV2 = z.infer<typeof ModelArtifactV2Schema>

export const ModelArtifactPageRequestV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema.optional(),
    artifact_kind: ModelArtifactKindV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_MODEL_ARTIFACT_PAGE_MAX_LIMIT)
      .default(V2_MODEL_ARTIFACT_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'ModelArtifactPageRequestV2' })
export type ModelArtifactPageRequestV2 = z.infer<typeof ModelArtifactPageRequestV2Schema>

export const ModelArtifactPageV2Schema = z
  .strictObject({
    items: z.array(ModelArtifactV2Schema).max(V2_MODEL_ARTIFACT_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'ModelArtifactPageV2' })
export type ModelArtifactPageV2 = z.infer<typeof ModelArtifactPageV2Schema>

export const SwiftStudioProviderOutputCandidateV2Schema = SwiftStudioOutputCandidateV2Schema.extend(
  {
    provider_generation: SwiftStudioProviderGenerationV2Schema,
    output_snapshot_digest: DigestHexSchema.nullable(),
  },
)
  .superRefine((candidate, context) => {
    if (candidate.importable !== (candidate.output_snapshot_digest !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['output_snapshot_digest'],
        message: 'Only importable candidates expose an output snapshot digest',
      })
    }
  })
  .meta({ id: 'SwiftStudioProviderOutputCandidateV2' })
export type SwiftStudioProviderOutputCandidateV2 = z.infer<
  typeof SwiftStudioProviderOutputCandidateV2Schema
>

export const SwiftStudioProviderOutputCandidatePageV2Schema = z
  .strictObject({
    provider_session_id: SwiftStudioProviderSessionIdV2Schema,
    provider_generation: SwiftStudioProviderGenerationV2Schema,
    items: z
      .array(SwiftStudioProviderOutputCandidateV2Schema)
      .max(V2_SWIFT_STUDIO_OUTPUT_MAX_ITEMS),
  })
  .meta({ id: 'SwiftStudioProviderOutputCandidatePageV2' })
export type SwiftStudioProviderOutputCandidatePageV2 = z.infer<
  typeof SwiftStudioProviderOutputCandidatePageV2Schema
>

export const SwiftStudioArtifactStagingObjectKeyV2Schema = z
  .string()
  .regex(SWIFT_ARTIFACT_STAGING_KEY)
export const ModelArtifactObjectKeyV2Schema = z.string().regex(MODEL_ARTIFACT_OBJECT_KEY)

export const SwiftStudioProviderArtifactImportRequestV2Schema = z
  .strictObject({
    request_id: DigestHexSchema,
    provider_session_id: SwiftStudioProviderSessionIdV2Schema,
    output_handle: SwiftStudioOutputHandleV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    display_name: ModelArtifactDisplayNameV2Schema,
    base_model: ModelArtifactBaseModelRequestV2Schema,
    staging_object_key: SwiftStudioArtifactStagingObjectKeyV2Schema,
    staging_max_size_bytes: z
      .number()
      .int()
      .safe()
      .positive()
      .max(64 * 1024 * 1024 * 1024),
    staging_upload_url: z.url().max(8_192),
    staging_upload_expires_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'SwiftStudioProviderArtifactImportRequestV2' })
export type SwiftStudioProviderArtifactImportRequestV2 = z.infer<
  typeof SwiftStudioProviderArtifactImportRequestV2Schema
>

export const SwiftStudioProviderArtifactImportStatusV2Schema = z.enum([
  'staging',
  'staged',
  'failed',
])

const SwiftStudioProviderSummaryTokenV2Schema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u)

const SwiftStudioProviderAdapterSummaryV2Schema = z.strictObject({
  peft_type: SwiftStudioProviderSummaryTokenV2Schema.optional(),
  task_type: SwiftStudioProviderSummaryTokenV2Schema.optional(),
  rank: z.number().int().safe().positive().max(65_536).optional(),
  alpha: z.number().finite().nonnegative().max(1_000_000).optional(),
  dropout: z.number().finite().min(0).max(1).optional(),
  bias: SwiftStudioProviderSummaryTokenV2Schema.optional(),
  target_modules: z.array(SwiftStudioProviderSummaryTokenV2Schema).max(256).optional(),
})

const SwiftStudioProviderMetadataFileV2Schema = ModelArtifactManifestFileV2Schema.extend({
  digest_algorithm: z.literal('blake3'),
})

export const SwiftStudioProviderArtifactMetadataV2Schema = z
  .strictObject({
    provider_metadata_version: z.literal('swift-lora-snapshot-v1'),
    artifact_kind: ModelArtifactKindV2Schema,
    artifact_format: ModelArtifactFormatV2Schema,
    archive_format: ModelArtifactArchiveFormatV2Schema,
    source: z.strictObject({
      provider_generation: SwiftStudioProviderGenerationV2Schema,
      provider_session_id: SwiftStudioProviderSessionIdV2Schema,
    }),
    adapter: SwiftStudioProviderAdapterSummaryV2Schema,
    base_model: z.strictObject({
      reference: ModelArtifactBaseModelReferenceV2Schema.nullable(),
      revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
      binding_status: ModelArtifactBaseModelBindingStatusV2Schema,
    }),
    training_summary: ModelArtifactTrainingSummaryV2Schema,
    dataset_lineage: ModelArtifactDatasetLineageV2Schema,
    archive_digest_algorithm: z.literal('blake3'),
    archive_digest: DigestHexSchema,
    archive_size_bytes: NonNegativeSafeIntegerSchema,
    output_snapshot_digest: DigestHexSchema,
    files: z
      .array(SwiftStudioProviderMetadataFileV2Schema)
      .min(2)
      .max(V2_MODEL_ARTIFACT_MANIFEST_MAX_FILES),
  })
  .meta({ id: 'SwiftStudioProviderArtifactMetadataV2' })
export type SwiftStudioProviderArtifactMetadataV2 = z.infer<
  typeof SwiftStudioProviderArtifactMetadataV2Schema
>

export const SwiftStudioProviderArtifactImportV2Schema = z
  .strictObject({
    provider_import_id: SwiftStudioProviderArtifactImportIdV2Schema,
    request_id: DigestHexSchema,
    provider_session_id: SwiftStudioProviderSessionIdV2Schema,
    provider_generation: SwiftStudioProviderGenerationV2Schema,
    status: SwiftStudioProviderArtifactImportStatusV2Schema,
    output_snapshot_digest: DigestHexSchema,
    staging_object_key: SwiftStudioArtifactStagingObjectKeyV2Schema,
    archive_digest: DigestHexSchema.nullable(),
    archive_size_bytes: NonNegativeSafeIntegerSchema.nullable(),
    provider_metadata: SwiftStudioProviderArtifactMetadataV2Schema.nullable(),
    failure: ModelArtifactImportFailureV2Schema.nullable(),
    replayed: z.boolean(),
  })
  .superRefine((providerImport, context) => {
    const stagedFields = [
      providerImport.archive_digest,
      providerImport.archive_size_bytes,
      providerImport.provider_metadata,
    ]
    if ((providerImport.status === 'staged') !== stagedFields.every((value) => value !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['archive_digest'],
        message: 'Only staged Provider imports expose complete archive metadata',
      })
    }
    if ((providerImport.status === 'failed') !== (providerImport.failure !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only failed Provider imports expose a failure summary',
      })
    }
  })
  .meta({ id: 'SwiftStudioProviderArtifactImportV2' })
export type SwiftStudioProviderArtifactImportV2 = z.infer<
  typeof SwiftStudioProviderArtifactImportV2Schema
>
