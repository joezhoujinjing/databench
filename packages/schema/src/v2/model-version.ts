import {
  type ModelRegistrationPlanArtifactIdentityV1,
  type ModelRegistrationPlanRepositoryIdentityV1,
  type ModelRegistrationPlanServiceIdentityV1,
  type ModelSourceFingerprintArtifactIdentityV1,
  type ModelSourceFingerprintRepositoryIdentityV1,
  type ModelSourceFingerprintServiceIdentityV1,
  type ModelVersionCreateArtifactIdentityV1,
  type ModelVersionCreateRepositoryIdentityV1,
  type ModelVersionCreateServiceIdentityV1,
  V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE,
  V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE,
  V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE,
  V2_MODEL_VERSION_CREATE_SERVICE_PROFILE,
} from '@databench/hashing'
import { z } from 'zod'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import { IdentityNamespaceV2Schema } from './identity.js'
import {
  ModelIdV2Schema,
  ModelRegistrationTargetV2Schema,
  modelRegistryBoundedTextV2,
} from './model.js'
import {
  ModelArtifactBaseModelBindingStatusV2Schema,
  ModelArtifactBaseModelReferenceV2Schema,
  ModelArtifactBaseModelRevisionV2Schema,
  ModelArtifactFormatV2Schema,
  ModelArtifactIdV2Schema,
  ModelArtifactKindV2Schema,
} from './model-artifact.js'
import {
  ModelDeploymentDisplayNameV2Schema,
  ModelDeploymentEndpointBaseUrlV2Schema,
  ModelDeploymentServedModelNameV2Schema,
  normalizeModelDeploymentEndpointBaseUrlV2,
} from './model-deployment.js'

export const V2_MODEL_REGISTRATION_WARNING_MAX_ITEMS = 32
export const V2_MODEL_DECLARED_INTERFACE_MAX_ITEMS = 4

const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const REPOSITORY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,255}$/
const CREDENTIAL_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/
const LOCAL_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|(?:\.\.?)[\\/]|(?:~)[\\/])/i
const WINDOWS_SEPARATOR = /\\/

export const ModelVersionIdV2Schema = z.uuid()
export const ModelVersionLabelV2Schema = modelRegistryBoundedTextV2(128, { rejectPath: true })
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
export const ModelRepositoryProviderV2Schema = z.enum([
  'hugging_face',
  'modelscope',
  'operator_managed',
])
export const ModelRepositoryRevisionKindV2Schema = z.enum(['commit', 'digest', 'tag', 'opaque'])
export const ModelServiceDeclaredReferenceKindV2Schema = z.enum([
  'immutable_version',
  'mutable_alias',
  'opaque',
])

export const ModelRepositoryIdV2Schema = modelRegistryBoundedTextV2(512, {
  rejectPath: true,
}).refine((value) => !WINDOWS_SEPARATOR.test(value) && !value.includes('..'), {
  message: 'Repository ID must be a provider ID or opaque operator alias, not a path',
})
export const ModelRepositoryRevisionV2Schema = z
  .string()
  .transform((value) => value.trim().normalize('NFC'))
  .pipe(z.string().regex(REPOSITORY_REVISION))
  .refine(
    (value) =>
      !LOCAL_PATH.test(value) && !WINDOWS_SEPARATOR.test(value) && !value.split('/').includes('..'),
    { message: 'Repository revision cannot be a local path' },
  )
export const ModelExternalReferenceV2Schema = modelRegistryBoundedTextV2(512, {
  rejectPath: true,
})

export const ModelVersionBaseModelV2Schema = z.strictObject({
  reference: ModelArtifactBaseModelReferenceV2Schema,
  revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
})

export const ModelConnectivityScopeV2Schema = z.enum(['private_network', 'public_network'])
export const ModelAuthProfileV2Schema = z.enum(['none', 'bearer_ref'])
export const ModelCredentialRefV2Schema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(CREDENTIAL_REF))
  .refine((value) => !value.includes('..'), { message: 'Credential ref cannot contain ..' })
export const ModelDeclaredInterfaceV2Schema = z.enum([
  'chat_completions',
  'embeddings',
  'vision',
  'tools',
])
export const ModelDeclaredCapabilitiesV2Schema = z.strictObject({
  interfaces: z
    .array(ModelDeclaredInterfaceV2Schema)
    .min(1)
    .max(V2_MODEL_DECLARED_INTERFACE_MAX_ITEMS)
    .transform((values) => [...new Set(values)].sort()),
  context_limit: z.number().int().safe().min(1).max(10_000_000).nullable(),
})
export const ModelDeploymentDraftV2Schema = z
  .strictObject({
    display_name: ModelDeploymentDisplayNameV2Schema,
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    connectivity_scope: ModelConnectivityScopeV2Schema,
    endpoint_base_url: ModelDeploymentEndpointBaseUrlV2Schema.transform((value, context) => {
      const normalized = normalizeModelDeploymentEndpointBaseUrlV2(value)
      if (normalized === null) {
        context.addIssue({ code: 'custom', message: 'Endpoint base URL cannot be normalized' })
        return z.NEVER
      }
      return normalized
    }),
    auth_profile: ModelAuthProfileV2Schema,
    credential_ref: ModelCredentialRefV2Schema.nullable(),
    declared_capabilities: ModelDeclaredCapabilitiesV2Schema,
  })
  .superRefine((deployment, context) => {
    if ((deployment.auth_profile === 'bearer_ref') !== (deployment.credential_ref !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['credential_ref'],
        message: 'bearer_ref requires one credential ref and none forbids it',
      })
    }
  })

export const ModelArtifactRegistrationSourceV2Schema = z.strictObject({
  kind: z.literal('databench_artifact'),
  artifact_id: ModelArtifactIdV2Schema,
  deployment: ModelDeploymentDraftV2Schema.optional(),
})
export const ModelRepositoryRegistrationSourceV2Schema = z.strictObject({
  kind: z.literal('repository_reference'),
  provider: ModelRepositoryProviderV2Schema,
  repository_id: ModelRepositoryIdV2Schema,
  revision: ModelRepositoryRevisionV2Schema,
  revision_kind: ModelRepositoryRevisionKindV2Schema,
  base_model: ModelVersionBaseModelV2Schema.nullable(),
  deployment: ModelDeploymentDraftV2Schema.optional(),
})
export const ModelServiceRegistrationSourceV2Schema = z.strictObject({
  kind: z.literal('existing_service'),
  provider: z.literal('openai_compatible'),
  external_model_ref: ModelExternalReferenceV2Schema,
  external_version_ref: ModelExternalReferenceV2Schema,
  declared_reference_kind: ModelServiceDeclaredReferenceKindV2Schema,
  base_model: ModelVersionBaseModelV2Schema.nullable(),
  deployment: ModelDeploymentDraftV2Schema,
})
export const ModelRegistrationSourceV2Schema = z.discriminatedUnion('kind', [
  ModelArtifactRegistrationSourceV2Schema,
  ModelRepositoryRegistrationSourceV2Schema,
  ModelServiceRegistrationSourceV2Schema,
])
export type ModelRegistrationSourceV2 = z.infer<typeof ModelRegistrationSourceV2Schema>

export const ModelAliasNameV2Schema = z.enum(['candidate', 'staging', 'production'])
export const ModelRegistrationAliasV2Schema = z.strictObject({
  alias: ModelAliasNameV2Schema,
  expected_version_id: ModelVersionIdV2Schema.nullable(),
})

const registrationRequestShape = {
  target: ModelRegistrationTargetV2Schema,
  version_label: ModelVersionLabelV2Schema,
  alias: ModelRegistrationAliasV2Schema.optional(),
}
export const ModelArtifactRegistrationRequestV2Schema = z.strictObject({
  ...registrationRequestShape,
  source: ModelArtifactRegistrationSourceV2Schema,
})
export type ModelArtifactRegistrationRequestV2 = z.infer<
  typeof ModelArtifactRegistrationRequestV2Schema
>
export const ModelRepositoryRegistrationRequestV2Schema = z.strictObject({
  ...registrationRequestShape,
  source: ModelRepositoryRegistrationSourceV2Schema,
})
export type ModelRepositoryRegistrationRequestV2 = z.infer<
  typeof ModelRepositoryRegistrationRequestV2Schema
>
export const ModelServiceRegistrationRequestV2Schema = z.strictObject({
  ...registrationRequestShape,
  source: ModelServiceRegistrationSourceV2Schema,
})
export type ModelServiceRegistrationRequestV2 = z.infer<
  typeof ModelServiceRegistrationRequestV2Schema
>
export const ModelRegistrationInspectRequestV2Schema = z.union([
  ModelArtifactRegistrationRequestV2Schema,
  ModelRepositoryRegistrationRequestV2Schema,
  ModelServiceRegistrationRequestV2Schema,
])
export type ModelRegistrationInspectRequestV2 = z.infer<
  typeof ModelRegistrationInspectRequestV2Schema
>

export const ModelRegistrationWarningV2Schema = z.strictObject({
  code: z.string().regex(SAFE_TOKEN),
  path: z.string().min(1).max(512),
  message: modelRegistryBoundedTextV2(1_024),
})
export type ModelRegistrationWarningV2 = z.infer<typeof ModelRegistrationWarningV2Schema>
export const ModelSourceClassificationV2Schema = z.strictObject({
  source_mutability: ModelSourceMutabilityV2Schema,
  verification_level: ModelVerificationLevelV2Schema,
  evidence_digest: DigestHexSchema.nullable(),
})

const registrationPlanCommonShape = {
  model_id: ModelIdV2Schema,
  model_create_digest: DigestHexSchema.nullable(),
  source_fingerprint: DigestHexSchema,
  version_create_digest: DigestHexSchema,
  classification: ModelSourceClassificationV2Schema,
  warnings: z.array(ModelRegistrationWarningV2Schema).max(V2_MODEL_REGISTRATION_WARNING_MAX_ITEMS),
  registration_digest: DigestHexSchema,
}
export const ModelRegistrationPlanArtifactV2Schema = z.strictObject({
  plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE),
  normalized_request: ModelArtifactRegistrationRequestV2Schema,
  ...registrationPlanCommonShape,
})
export const ModelRegistrationPlanRepositoryV2Schema = z.strictObject({
  plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE),
  normalized_request: ModelRepositoryRegistrationRequestV2Schema,
  ...registrationPlanCommonShape,
})
export const ModelRegistrationPlanServiceV2Schema = z.strictObject({
  plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE),
  normalized_request: ModelServiceRegistrationRequestV2Schema,
  ...registrationPlanCommonShape,
})
export const ModelRegistrationPlanV2Schema = z.discriminatedUnion('plan_profile', [
  ModelRegistrationPlanArtifactV2Schema,
  ModelRegistrationPlanRepositoryV2Schema,
  ModelRegistrationPlanServiceV2Schema,
])
export type ModelRegistrationPlanV2 = z.infer<typeof ModelRegistrationPlanV2Schema>

export const CommitModelRegistrationRequestV2Schema = z.strictObject({
  request: ModelRegistrationInspectRequestV2Schema,
  expected_registration_digest: DigestHexSchema,
})
export type CommitModelRegistrationRequestV2 = z.infer<
  typeof CommitModelRegistrationRequestV2Schema
>

export const ModelSourceEvidenceV2Schema = z
  .strictObject({
    evidence_kind: z.enum(['provider_resolution', 'operator_attestation']),
    adapter: z.string().regex(SAFE_TOKEN),
    adapter_version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    observed_revision: ModelRepositoryRevisionV2Schema.nullable(),
    observed_at: Rfc3339UtcSchema,
    result: z.enum(['verified', 'not_found', 'unavailable', 'invalid']),
    response_digest: DigestHexSchema.nullable(),
  })
  .superRefine((evidence, context) => {
    if (
      evidence.result === 'verified' &&
      (evidence.observed_revision === null || evidence.response_digest === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Verified evidence requires observed revision and response digest',
      })
    }
  })
export type ModelSourceEvidenceV2 = z.infer<typeof ModelSourceEvidenceV2Schema>

export function classifyModelVersionSourceV2(
  source: ModelRegistrationSourceV2,
  evidence: readonly ModelSourceEvidenceV2[] = [],
): z.infer<typeof ModelSourceClassificationV2Schema> {
  if (source.kind === 'databench_artifact') {
    return {
      source_mutability: 'immutable',
      verification_level: 'content_verified',
      evidence_digest: null,
    }
  }

  const expectedRevision =
    source.kind === 'repository_reference' ? source.revision : source.external_version_ref
  const verified = evidence.some(
    (entry) =>
      entry.result === 'verified' &&
      entry.observed_revision === expectedRevision &&
      entry.response_digest !== null,
  )
  const sourceIsDeclaredMutable =
    (source.kind === 'repository_reference' && source.revision_kind === 'tag') ||
    (source.kind === 'existing_service' && source.declared_reference_kind === 'mutable_alias')
  return {
    source_mutability: sourceIsDeclaredMutable ? 'mutable' : verified ? 'immutable' : 'unknown',
    verification_level: verified ? 'provider_verified' : 'operator_attested',
    evidence_digest: null,
  }
}

export const ModelSourceFingerprintArtifactIdentityV1Schema: z.ZodType<ModelSourceFingerprintArtifactIdentityV1> =
  z.strictObject({
    source_fingerprint_profile: z.literal(V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE),
    artifact_id: ModelArtifactIdV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    artifact_format: ModelArtifactFormatV2Schema,
    archive_digest: DigestHexSchema,
    manifest_digest: DigestHexSchema,
  })

export const ModelSourceFingerprintRepositoryIdentityV1Schema: z.ZodType<ModelSourceFingerprintRepositoryIdentityV1> =
  z.strictObject({
    source_fingerprint_profile: z.literal(V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE),
    provider: ModelRepositoryProviderV2Schema,
    repository_id: ModelRepositoryIdV2Schema,
    revision: ModelRepositoryRevisionV2Schema,
    revision_kind: ModelRepositoryRevisionKindV2Schema,
  })

export const ModelSourceFingerprintServiceIdentityV1Schema: z.ZodType<ModelSourceFingerprintServiceIdentityV1> =
  z.strictObject({
    source_fingerprint_profile: z.literal(V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE),
    provider: z.literal('openai_compatible'),
    external_model_ref: ModelExternalReferenceV2Schema,
    external_version_ref: ModelExternalReferenceV2Schema,
    declared_reference_kind: ModelServiceDeclaredReferenceKindV2Schema,
  })

const versionIdentityCommonShape = {
  namespace: IdentityNamespaceV2Schema,
  model_id: ModelIdV2Schema,
  version_label: ModelVersionLabelV2Schema,
  source_fingerprint: DigestHexSchema,
}
export const ModelVersionCreateArtifactIdentityV1Schema: z.ZodType<ModelVersionCreateArtifactIdentityV1> =
  z.strictObject({
    model_version_create_profile: z.literal(V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE),
    ...versionIdentityCommonShape,
    base_model_reference: ModelArtifactBaseModelReferenceV2Schema,
    base_model_revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
    base_model_binding_status: ModelArtifactBaseModelBindingStatusV2Schema,
  })
export const ModelVersionCreateRepositoryIdentityV1Schema: z.ZodType<ModelVersionCreateRepositoryIdentityV1> =
  z.strictObject({
    model_version_create_profile: z.literal(V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE),
    ...versionIdentityCommonShape,
    base_model_reference: ModelArtifactBaseModelReferenceV2Schema.nullable(),
    base_model_revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
  })
export const ModelVersionCreateServiceIdentityV1Schema: z.ZodType<ModelVersionCreateServiceIdentityV1> =
  z.strictObject({
    model_version_create_profile: z.literal(V2_MODEL_VERSION_CREATE_SERVICE_PROFILE),
    ...versionIdentityCommonShape,
    base_model_reference: ModelArtifactBaseModelReferenceV2Schema.nullable(),
    base_model_revision: ModelArtifactBaseModelRevisionV2Schema.nullable(),
  })

const registrationPlanIdentityCommonShape = {
  namespace: IdentityNamespaceV2Schema,
  model_id: ModelIdV2Schema,
  model_create_digest: DigestHexSchema.nullable(),
  source_fingerprint: DigestHexSchema,
  version_create_digest: DigestHexSchema,
  classification: ModelSourceClassificationV2Schema,
}
export const ModelRegistrationPlanArtifactIdentityV1Schema: z.ZodType<ModelRegistrationPlanArtifactIdentityV1> =
  z.strictObject({
    plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE),
    namespace: registrationPlanIdentityCommonShape.namespace,
    normalized_request: ModelArtifactRegistrationRequestV2Schema,
    model_id: registrationPlanIdentityCommonShape.model_id,
    model_create_digest: registrationPlanIdentityCommonShape.model_create_digest,
    source_fingerprint: registrationPlanIdentityCommonShape.source_fingerprint,
    version_create_digest: registrationPlanIdentityCommonShape.version_create_digest,
    classification: registrationPlanIdentityCommonShape.classification,
  })
export const ModelRegistrationPlanRepositoryIdentityV1Schema: z.ZodType<ModelRegistrationPlanRepositoryIdentityV1> =
  z.strictObject({
    plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE),
    namespace: registrationPlanIdentityCommonShape.namespace,
    normalized_request: ModelRepositoryRegistrationRequestV2Schema,
    model_id: registrationPlanIdentityCommonShape.model_id,
    model_create_digest: registrationPlanIdentityCommonShape.model_create_digest,
    source_fingerprint: registrationPlanIdentityCommonShape.source_fingerprint,
    version_create_digest: registrationPlanIdentityCommonShape.version_create_digest,
    classification: registrationPlanIdentityCommonShape.classification,
  })
export const ModelRegistrationPlanServiceIdentityV1Schema: z.ZodType<ModelRegistrationPlanServiceIdentityV1> =
  z.strictObject({
    plan_profile: z.literal(V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE),
    namespace: registrationPlanIdentityCommonShape.namespace,
    normalized_request: ModelServiceRegistrationRequestV2Schema,
    model_id: registrationPlanIdentityCommonShape.model_id,
    model_create_digest: registrationPlanIdentityCommonShape.model_create_digest,
    source_fingerprint: registrationPlanIdentityCommonShape.source_fingerprint,
    version_create_digest: registrationPlanIdentityCommonShape.version_create_digest,
    classification: registrationPlanIdentityCommonShape.classification,
  })
