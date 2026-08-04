import {
  canonicalJsonV2,
  compareJcsUtf16,
  type ModelCreateIdentityV1,
  V2_MODEL_CREATE_PROFILE,
} from '@databench/hashing'
import { z } from 'zod'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import { OpaqueCursorQueryV2Schema } from './contracts.js'
import { IdentityNamespaceV2Schema } from './identity.js'

export const V2_MODEL_TAG_MAX_ITEMS = 32
export const V2_MODEL_PAGE_DEFAULT_LIMIT = 20
export const V2_MODEL_PAGE_MAX_LIMIT = 100

const encoder = new TextEncoder()
const MODEL_KEY = /^[a-z][a-z0-9-]{0,127}$/
const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|(?:\.\.?)[\\/]|(?:~)[\\/])/i

export function modelRegistryBoundedTextV2(
  maxBytes: number,
  options: { readonly allowEmpty?: boolean; readonly rejectPath?: boolean } = {},
) {
  const minimum = options.allowEmpty === true ? 0 : 1
  return z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(minimum).max(maxBytes))
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, {
      message: `Expected at most ${maxBytes} UTF-8 bytes`,
    })
    .refine(
      (value) => {
        try {
          canonicalJsonV2(value)
          return true
        } catch {
          return false
        }
      },
      { message: 'Text must contain Unicode scalar values' },
    )
    .refine(
      (value) => {
        for (const character of value) {
          const codePoint = character.codePointAt(0)
          if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false
        }
        return true
      },
      { message: 'Control characters are not allowed' },
    )
    .refine((value) => !CREDENTIAL_VALUE.test(value), {
      message: 'Credential-like values are not allowed',
    })
    .refine((value) => options.rejectPath !== true || !ABSOLUTE_PATH.test(value), {
      message: 'Local or absolute paths are not allowed',
    })
}

export const ModelIdV2Schema = z.uuid()
export const ModelSourceKindV2Schema = z.enum([
  'databench_artifact',
  'repository_reference',
  'existing_service',
])
export const ModelSourceMutabilityV2Schema = z.enum(['immutable', 'mutable', 'unknown'])
export const ModelVerificationLevelV2Schema = z.enum([
  'content_verified',
  'provider_verified',
  'operator_attested',
  'unverified',
])
export const ModelKeyV2Schema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(MODEL_KEY))
export const ModelDisplayNameV2Schema = modelRegistryBoundedTextV2(256, { rejectPath: true })
export const ModelDescriptionV2Schema = modelRegistryBoundedTextV2(2_048, {
  allowEmpty: true,
  rejectPath: true,
})
export const ModelTaskFamilyV2Schema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(SAFE_TOKEN))
export const ModelTagV2Schema = modelRegistryBoundedTextV2(64, { rejectPath: true })
export const ModelTagsV2Schema = z
  .array(ModelTagV2Schema)
  .max(V2_MODEL_TAG_MAX_ITEMS)
  .transform((items) => [...new Set(items)].sort(compareJcsUtf16))

export const CreateModelTargetV2Schema = z.strictObject({
  kind: z.literal('create_model'),
  key: ModelKeyV2Schema,
  display_name: ModelDisplayNameV2Schema,
  description: ModelDescriptionV2Schema,
  task_family: ModelTaskFamilyV2Schema.nullable(),
  tags: ModelTagsV2Schema,
})
export type CreateModelTargetV2 = z.infer<typeof CreateModelTargetV2Schema>

export const ExistingModelTargetV2Schema = z.strictObject({
  kind: z.literal('existing_model'),
  model_id: ModelIdV2Schema,
})
export type ExistingModelTargetV2 = z.infer<typeof ExistingModelTargetV2Schema>

export const ModelRegistrationTargetV2Schema = z.discriminatedUnion('kind', [
  CreateModelTargetV2Schema,
  ExistingModelTargetV2Schema,
])
export type ModelRegistrationTargetV2 = z.infer<typeof ModelRegistrationTargetV2Schema>

export const ModelCreateIdentityV1Schema: z.ZodType<ModelCreateIdentityV1> = z.strictObject({
  model_create_profile: z.literal(V2_MODEL_CREATE_PROFILE),
  namespace: IdentityNamespaceV2Schema,
  key: ModelKeyV2Schema,
})

export const ModelV2Schema = z
  .strictObject({
    id: ModelIdV2Schema,
    key: ModelKeyV2Schema,
    display_name: ModelDisplayNameV2Schema,
    description: ModelDescriptionV2Schema,
    task_family: ModelTaskFamilyV2Schema.nullable(),
    tags: ModelTagsV2Schema,
    metadata_revision: z.number().int().safe().nonnegative(),
    archived_at: Rfc3339UtcSchema.nullable(),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'ModelV2' })
export type ModelV2 = z.infer<typeof ModelV2Schema>

export const UpdateModelMetadataV2Schema = z
  .strictObject({
    expected_metadata_revision: z.number().int().safe().nonnegative(),
    display_name: ModelDisplayNameV2Schema,
    description: ModelDescriptionV2Schema,
    task_family: ModelTaskFamilyV2Schema.nullable(),
    tags: ModelTagsV2Schema,
  })
  .meta({ id: 'UpdateModelMetadataV2' })
export type UpdateModelMetadataV2 = z.infer<typeof UpdateModelMetadataV2Schema>

export const ArchiveModelV2Schema = z
  .strictObject({
    expected_metadata_revision: z.number().int().safe().nonnegative(),
  })
  .meta({ id: 'ArchiveModelV2' })
export type ArchiveModelV2 = z.infer<typeof ArchiveModelV2Schema>

export const ModelParamsV2Schema = z
  .strictObject({ model_id: ModelIdV2Schema })
  .meta({ id: 'ModelParamsV2' })

export const ModelArchiveFilterV2Schema = z.enum(['active', 'archived', 'all'])
export const ModelSearchV2Schema = modelRegistryBoundedTextV2(256, {
  allowEmpty: true,
  rejectPath: true,
})

export const ModelPageRequestV2Schema = z
  .strictObject({
    search: ModelSearchV2Schema.optional(),
    archive: ModelArchiveFilterV2Schema.default('active'),
    source_kind: ModelSourceKindV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_MODEL_PAGE_MAX_LIMIT)
      .default(V2_MODEL_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'ModelPageRequestV2' })
export type ModelPageRequestV2 = z.infer<typeof ModelPageRequestV2Schema>

export const ModelCandidateSummaryV2Schema = z.strictObject({
  version_id: z.uuid(),
  version_label: modelRegistryBoundedTextV2(128, { rejectPath: true }),
  source_kind: ModelSourceKindV2Schema,
  source_mutability: ModelSourceMutabilityV2Schema,
  verification_level: ModelVerificationLevelV2Schema,
  base_model_reference: modelRegistryBoundedTextV2(512, { rejectPath: true }).nullable(),
})

export const ModelListItemV2Schema = z
  .strictObject({
    model: ModelV2Schema,
    candidate: ModelCandidateSummaryV2Schema.nullable(),
    version_count: z.number().int().safe().nonnegative(),
    adopted_deployment_count: z.number().int().safe().nonnegative(),
    healthy_adopted_deployment_count: z.number().int().safe().nonnegative(),
  })
  .meta({ id: 'ModelListItemV2' })
export type ModelListItemV2 = z.infer<typeof ModelListItemV2Schema>

export const ModelPageV2Schema = z
  .strictObject({
    items: z.array(ModelListItemV2Schema).max(V2_MODEL_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'ModelPageV2' })
export type ModelPageV2 = z.infer<typeof ModelPageV2Schema>

export const ModelCreateDigestV2Schema = DigestHexSchema
