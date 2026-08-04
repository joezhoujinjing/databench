import {
  type ModelDeploymentAdoptionIdentityV1,
  type ModelRegistrationPlanArtifactIdentityV1,
  type ModelRegistrationPlanRepositoryIdentityV1,
  type ModelRegistrationPlanServiceIdentityV1,
  type ModelSourceEvidenceIdentityV1,
  type ModelSourceFingerprintArtifactIdentityV1,
  type ModelSourceFingerprintRepositoryIdentityV1,
  type ModelSourceFingerprintServiceIdentityV1,
  type ModelVersionCreateArtifactIdentityV1,
  type ModelVersionCreateRepositoryIdentityV1,
  type ModelVersionCreateServiceIdentityV1,
  type ModelVersionDeploymentCreateIdentityV2,
  V2_MODEL_DEPLOYMENT_ADOPTION_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE,
  V2_MODEL_SOURCE_EVIDENCE_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE,
  V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE,
  V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE,
  V2_MODEL_VERSION_CREATE_SERVICE_PROFILE,
  V2_MODEL_VERSION_DEPLOYMENT_CREATE_PROFILE,
} from '@databench/hashing'
import { z } from 'zod'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import { OpaqueCursorQueryV2Schema } from './contracts.js'
import { IdentityNamespaceV2Schema } from './identity.js'
import {
  ModelIdV2Schema,
  ModelRegistrationTargetV2Schema,
  ModelSourceKindV2Schema,
  ModelSourceMutabilityV2Schema,
  ModelVerificationLevelV2Schema,
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
export const V2_MODEL_VERSION_PAGE_DEFAULT_LIMIT = 20
export const V2_MODEL_VERSION_PAGE_MAX_LIMIT = 100
export const V2_MODEL_VERSION_DEPLOYMENT_PAGE_DEFAULT_LIMIT = 20
export const V2_MODEL_VERSION_DEPLOYMENT_PAGE_MAX_LIMIT = 100

const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const REPOSITORY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,255}$/
const CREDENTIAL_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/
const LOCAL_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|(?:\.\.?)[\\/]|(?:~)[\\/])/i
const WINDOWS_SEPARATOR = /\\/
const HOSTED_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

export const ModelVersionIdV2Schema = z.uuid()
export const ModelVersionLabelV2Schema = modelRegistryBoundedTextV2(128, { rejectPath: true })
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

export const ModelVersionDeploymentCreateIdentityV2Schema: z.ZodType<ModelVersionDeploymentCreateIdentityV2> =
  z.strictObject({
    model_deployment_create_profile: z.literal(V2_MODEL_VERSION_DEPLOYMENT_CREATE_PROFILE),
    namespace: IdentityNamespaceV2Schema,
    model_version_id: ModelVersionIdV2Schema,
    source_fingerprint: DigestHexSchema,
    provider: z.literal('openai_compatible'),
    display_name: ModelDeploymentDisplayNameV2Schema,
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    endpoint_base_url: ModelDeploymentEndpointBaseUrlV2Schema,
    connectivity_scope: ModelConnectivityScopeV2Schema,
    auth_profile: ModelAuthProfileV2Schema,
    credential_ref: ModelCredentialRefV2Schema.nullable(),
    declared_capabilities: ModelDeclaredCapabilitiesV2Schema,
  })

export const ModelVersionDeploymentLifecycleV2Schema = z.enum(['registered', 'active', 'disabled'])
export const ModelVersionDeploymentAvailabilityV2Schema = z.enum(['available', 'unavailable'])
export const ModelVersionDeploymentUnavailableReasonV2Schema = z.enum([
  'not_active',
  'public_network_disabled',
  'policy_generation_changed',
  'credential_generation_changed',
  'credential_unavailable',
  'runtime_unavailable',
])
export const ModelVersionDeploymentHealthStatusV2Schema = z.enum([
  'unknown',
  'healthy',
  'unhealthy',
])
export const ModelVersionDeploymentHealthErrorCodeV2Schema = z.enum([
  'timeout',
  'network_error',
  'http_error',
  'invalid_response',
  'served_model_missing',
  'policy_rejected',
  'credential_rejected',
  'configuration_changed',
  'unhealthy',
])

export const ModelVersionDeploymentParamsV2Schema = z
  .strictObject({
    version_id: ModelVersionIdV2Schema,
    deployment_id: z.uuid(),
  })
  .meta({ id: 'ModelVersionDeploymentParamsV2' })

export const CreateModelVersionDeploymentRequestV2Schema = ModelDeploymentDraftV2Schema.meta({
  id: 'CreateModelVersionDeploymentRequestV2',
})
export type CreateModelVersionDeploymentRequestV2 = z.infer<
  typeof CreateModelVersionDeploymentRequestV2Schema
>

export const ActivateModelVersionDeploymentRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'ActivateModelVersionDeploymentRequestV2' })
export const CheckModelVersionDeploymentRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'CheckModelVersionDeploymentRequestV2' })
export const DisableModelVersionDeploymentRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'DisableModelVersionDeploymentRequestV2' })

export const ModelVersionDeploymentPageRequestV2Schema = z
  .strictObject({
    lifecycle: ModelVersionDeploymentLifecycleV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_MODEL_VERSION_DEPLOYMENT_PAGE_MAX_LIMIT)
      .default(V2_MODEL_VERSION_DEPLOYMENT_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'ModelVersionDeploymentPageRequestV2' })
export type ModelVersionDeploymentPageRequestV2 = z.infer<
  typeof ModelVersionDeploymentPageRequestV2Schema
>

export const ModelVersionDeploymentV2Schema = z
  .strictObject({
    id: z.uuid(),
    model_version_id: ModelVersionIdV2Schema,
    display_name: ModelDeploymentDisplayNameV2Schema,
    provider: z.literal('openai_compatible'),
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    connectivity_scope: ModelConnectivityScopeV2Schema,
    auth_profile: ModelAuthProfileV2Schema,
    declared_capabilities: ModelDeclaredCapabilitiesV2Schema,
    lifecycle: ModelVersionDeploymentLifecycleV2Schema,
    availability: ModelVersionDeploymentAvailabilityV2Schema,
    unavailable_reason: ModelVersionDeploymentUnavailableReasonV2Schema.nullable(),
    health_status: ModelVersionDeploymentHealthStatusV2Schema,
    health_checked_at: Rfc3339UtcSchema.nullable(),
    health_error_code: ModelVersionDeploymentHealthErrorCodeV2Schema.nullable(),
    created_at: Rfc3339UtcSchema,
    activated_at: Rfc3339UtcSchema.nullable(),
    disabled_at: Rfc3339UtcSchema.nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .superRefine((deployment, context) => {
    if ((deployment.availability === 'unavailable') !== (deployment.unavailable_reason !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['unavailable_reason'],
        message: 'Unavailable deployments require one unavailable reason',
      })
    }
    if ((deployment.health_status === 'unknown') !== (deployment.health_checked_at === null)) {
      context.addIssue({
        code: 'custom',
        path: ['health_checked_at'],
        message: 'Known health observations require health_checked_at',
      })
    }
    if ((deployment.health_status === 'unhealthy') !== (deployment.health_error_code !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['health_error_code'],
        message: 'Only unhealthy deployments expose a health error code',
      })
    }
    if ((deployment.lifecycle === 'disabled') !== (deployment.disabled_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['disabled_at'],
        message: 'Only disabled deployments expose disabled_at',
      })
    }
    if (deployment.lifecycle === 'active' && deployment.activated_at === null) {
      context.addIssue({
        code: 'custom',
        path: ['activated_at'],
        message: 'Active deployments require activated_at',
      })
    }
    if (deployment.lifecycle === 'registered' && deployment.activated_at !== null) {
      context.addIssue({
        code: 'custom',
        path: ['activated_at'],
        message: 'Registered deployments cannot expose activated_at',
      })
    }
  })
  .meta({ id: 'ModelVersionDeploymentV2' })
export type ModelVersionDeploymentV2 = z.infer<typeof ModelVersionDeploymentV2Schema>

export const ModelVersionDeploymentPageV2Schema = z
  .strictObject({
    items: z.array(ModelVersionDeploymentV2Schema).max(V2_MODEL_VERSION_DEPLOYMENT_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'ModelVersionDeploymentPageV2' })
export type ModelVersionDeploymentPageV2 = z.infer<typeof ModelVersionDeploymentPageV2Schema>

export const ModelArtifactRegistrationSourceV2Schema = z.strictObject({
  kind: z.literal('databench_artifact'),
  artifact_id: ModelArtifactIdV2Schema,
  deployment: ModelDeploymentDraftV2Schema.optional(),
})
export const ModelRepositoryRegistrationSourceV2Schema = z
  .strictObject({
    kind: z.literal('repository_reference'),
    provider: ModelRepositoryProviderV2Schema,
    repository_id: ModelRepositoryIdV2Schema,
    revision: ModelRepositoryRevisionV2Schema,
    revision_kind: ModelRepositoryRevisionKindV2Schema,
    base_model: ModelVersionBaseModelV2Schema.nullable(),
    deployment: ModelDeploymentDraftV2Schema.optional(),
  })
  .superRefine((source, context) => {
    if (source.provider === 'operator_managed') {
      if (!SAFE_TOKEN.test(source.repository_id)) {
        context.addIssue({
          code: 'custom',
          path: ['repository_id'],
          message: 'Operator-managed repository ID must be an opaque lowercase alias',
        })
      }
      return
    }
    if (!HOSTED_REPOSITORY_ID.test(source.repository_id)) {
      context.addIssue({
        code: 'custom',
        path: ['repository_id'],
        message: 'Hosted repository ID must be a canonical owner/name pair',
      })
    }
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
  deployment: z.strictObject({ id: z.uuid(), create_digest: DigestHexSchema }).nullable(),
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

export const CommitArtifactModelRegistrationRequestV2Schema = z
  .strictObject({
    request: ModelArtifactRegistrationRequestV2Schema,
    expected_registration_digest: DigestHexSchema,
  })
  .meta({ id: 'CommitArtifactModelRegistrationRequestV2' })
export type CommitArtifactModelRegistrationRequestV2 = z.infer<
  typeof CommitArtifactModelRegistrationRequestV2Schema
>

export const ModelRegistryRegistrationRequestV2Schema = z
  .union([
    ModelArtifactRegistrationRequestV2Schema,
    ModelRepositoryRegistrationRequestV2Schema,
    ModelServiceRegistrationRequestV2Schema,
  ])
  .meta({ id: 'ModelRegistryRegistrationRequestV2' })
export type ModelRegistryRegistrationRequestV2 = z.infer<
  typeof ModelRegistryRegistrationRequestV2Schema
>

export const CommitModelRegistryRegistrationRequestV2Schema = z
  .strictObject({
    request: ModelRegistryRegistrationRequestV2Schema,
    expected_registration_digest: DigestHexSchema,
  })
  .meta({ id: 'CommitModelRegistryRegistrationRequestV2' })
export type CommitModelRegistryRegistrationRequestV2 = z.infer<
  typeof CommitModelRegistryRegistrationRequestV2Schema
>

export const ModelRegistryRegistrationPlanV2Schema = z
  .union([
    ModelRegistrationPlanArtifactV2Schema,
    ModelRegistrationPlanRepositoryV2Schema,
    ModelRegistrationPlanServiceV2Schema,
  ])
  .meta({ id: 'ModelRegistryRegistrationPlanV2' })

export const ModelRegistrationCommitResultV2Schema = z
  .strictObject({
    registration_digest: DigestHexSchema,
    model_id: ModelIdV2Schema,
    model_version_id: ModelVersionIdV2Schema,
    source_fingerprint: DigestHexSchema,
    deployment_id: z.uuid().nullable(),
    deployment_digest: DigestHexSchema.nullable(),
    alias: ModelAliasNameV2Schema.nullable(),
    replayed: z.boolean(),
  })
  .superRefine((result, context) => {
    if ((result.deployment_id === null) !== (result.deployment_digest === null)) {
      context.addIssue({
        code: 'custom',
        path: ['deployment_id'],
        message: 'Deployment ID and digest must both be present or absent',
      })
    }
  })
  .meta({ id: 'ModelRegistrationCommitResultV2' })
export type ModelRegistrationCommitResultV2 = z.infer<typeof ModelRegistrationCommitResultV2Schema>

export const ModelSourceEvidenceV2Schema = z
  .strictObject({
    evidence_kind: z.enum(['provider_resolution', 'operator_attestation']),
    adapter: z.string().regex(SAFE_TOKEN),
    adapter_version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    observed_revision: ModelRepositoryRevisionV2Schema.nullable(),
    observed_at: Rfc3339UtcSchema,
    result: z.enum(['verified', 'not_found', 'unavailable', 'invalid', 'revision_mismatch']),
    response_digest: DigestHexSchema.nullable(),
    license: modelRegistryBoundedTextV2(256, { rejectPath: true }).nullable().default(null),
    cache_status: z.enum(['cached', 'not_cached', 'unknown']).default('unknown'),
  })
  .superRefine((evidence, context) => {
    if (
      (evidence.result === 'verified' || evidence.result === 'revision_mismatch') &&
      (evidence.observed_revision === null || evidence.response_digest === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Revision evidence requires observed revision and response digest',
      })
    }
  })
export type ModelSourceEvidenceV2 = z.infer<typeof ModelSourceEvidenceV2Schema>

export const ModelSourceEvidenceIdentityV1Schema: z.ZodType<ModelSourceEvidenceIdentityV1> =
  z.strictObject({
    evidence_profile: z.literal(V2_MODEL_SOURCE_EVIDENCE_PROFILE),
    namespace: IdentityNamespaceV2Schema,
    model_version_id: ModelVersionIdV2Schema,
    evidence_kind: ModelSourceEvidenceV2Schema.shape.evidence_kind,
    adapter: ModelSourceEvidenceV2Schema.shape.adapter,
    adapter_version: ModelSourceEvidenceV2Schema.shape.adapter_version,
    observed_revision: ModelSourceEvidenceV2Schema.shape.observed_revision,
    result: ModelSourceEvidenceV2Schema.shape.result,
    response_digest: ModelSourceEvidenceV2Schema.shape.response_digest,
    license: ModelSourceEvidenceV2Schema.shape.license,
    cache_status: ModelSourceEvidenceV2Schema.shape.cache_status,
  })

export const ModelSourceEvidenceRecordV2Schema = ModelSourceEvidenceV2Schema.extend({
  evidence_digest: DigestHexSchema,
}).meta({ id: 'ModelSourceEvidenceRecordV2' })
export type ModelSourceEvidenceRecordV2 = z.infer<typeof ModelSourceEvidenceRecordV2Schema>

export const ModelRepositoryObservationV2Schema = z.strictObject({
  availability: z.enum(['unobserved', 'available', 'not_found', 'unavailable', 'invalid']),
  license: modelRegistryBoundedTextV2(256, { rejectPath: true }).nullable(),
  cache_status: z.enum(['cached', 'not_cached', 'unknown']),
  evidence_count: z.number().int().safe().nonnegative().max(1_000),
  latest_evidence: ModelSourceEvidenceRecordV2Schema.nullable(),
  materialization: z.strictObject({
    state: z.literal('not_materialized'),
    handoff: z.literal('future_import_job'),
  }),
})
export type ModelRepositoryObservationV2 = z.infer<typeof ModelRepositoryObservationV2Schema>

export const ModelVersionSourceV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('databench_artifact'),
    artifact_id: ModelArtifactIdV2Schema,
    artifact_kind: ModelArtifactKindV2Schema,
    artifact_format: ModelArtifactFormatV2Schema,
    archive_digest: DigestHexSchema,
    manifest_digest: DigestHexSchema,
  }),
  z.strictObject({
    kind: z.literal('repository_reference'),
    provider: ModelRepositoryProviderV2Schema,
    repository_id: ModelRepositoryIdV2Schema,
    revision: ModelRepositoryRevisionV2Schema,
    revision_kind: ModelRepositoryRevisionKindV2Schema,
  }),
  z.strictObject({
    kind: z.literal('existing_service'),
    provider: z.literal('openai_compatible'),
    external_model_ref: ModelExternalReferenceV2Schema,
    external_version_ref: ModelExternalReferenceV2Schema,
    declared_reference_kind: ModelServiceDeclaredReferenceKindV2Schema,
  }),
])
export type ModelVersionSourceV2 = z.infer<typeof ModelVersionSourceV2Schema>

const resolvedModelVersionDeploymentCommonShape = {
  id: z.uuid(),
  model_id: ModelIdV2Schema,
  model_version_id: ModelVersionIdV2Schema,
  create_digest: DigestHexSchema,
  source_fingerprint: DigestHexSchema,
  provider: z.literal('openai_compatible'),
  served_model_name: ModelDeploymentServedModelNameV2Schema,
  endpoint_base_url: ModelDeploymentEndpointBaseUrlV2Schema,
  connectivity_scope: ModelConnectivityScopeV2Schema,
  auth_profile: ModelAuthProfileV2Schema,
  credential_ref: ModelCredentialRefV2Schema.nullable(),
  declared_capabilities: ModelDeclaredCapabilitiesV2Schema,
}

export const ResolvedModelVersionDeploymentV2Schema = z
  .discriminatedUnion('source_kind', [
    z.strictObject({
      ...resolvedModelVersionDeploymentCommonShape,
      source_kind: z.literal('databench_artifact'),
      artifact_id: ModelArtifactIdV2Schema,
      source: ModelVersionSourceV2Schema.options[0],
    }),
    z.strictObject({
      ...resolvedModelVersionDeploymentCommonShape,
      source_kind: z.literal('repository_reference'),
      artifact_id: z.null(),
      source: ModelVersionSourceV2Schema.options[1],
    }),
    z.strictObject({
      ...resolvedModelVersionDeploymentCommonShape,
      source_kind: z.literal('existing_service'),
      artifact_id: z.null(),
      source: ModelVersionSourceV2Schema.options[2],
    }),
  ])
  .meta({ id: 'ResolvedModelVersionDeploymentV2' })
export type ResolvedModelVersionDeploymentV2 = z.infer<
  typeof ResolvedModelVersionDeploymentV2Schema
>

export const ModelVersionV2Schema = z
  .strictObject({
    id: ModelVersionIdV2Schema,
    model_id: ModelIdV2Schema,
    version_label: ModelVersionLabelV2Schema,
    source_kind: ModelSourceKindV2Schema,
    source_fingerprint: DigestHexSchema,
    base_model: ModelVersionBaseModelV2Schema.nullable(),
    base_model_binding_status: ModelArtifactBaseModelBindingStatusV2Schema.nullable(),
    classification: ModelSourceClassificationV2Schema,
    source: ModelVersionSourceV2Schema,
    repository_observation: ModelRepositoryObservationV2Schema.nullable(),
    created_at: Rfc3339UtcSchema,
  })
  .superRefine((version, context) => {
    if (version.source.kind !== version.source_kind) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Model Version source must match source_kind',
      })
    }
    if (
      (version.source_kind === 'databench_artifact') !==
      (version.base_model_binding_status !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['base_model_binding_status'],
        message: 'Only Artifact sources expose a base binding status',
      })
    }
    if (
      (version.source_kind === 'repository_reference') !==
      (version.repository_observation !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['repository_observation'],
        message: 'Only Repository sources expose repository observation',
      })
    }
  })
  .meta({ id: 'ModelVersionV2' })
export type ModelVersionV2 = z.infer<typeof ModelVersionV2Schema>

export const ModelVersionParamsV2Schema = z
  .strictObject({ version_id: ModelVersionIdV2Schema })
  .meta({ id: 'ModelVersionParamsV2' })

export const RefreshModelSourceEvidenceRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'RefreshModelSourceEvidenceRequestV2' })
export type RefreshModelSourceEvidenceRequestV2 = z.infer<
  typeof RefreshModelSourceEvidenceRequestV2Schema
>

export const ModelVersionPageRequestV2Schema = z
  .strictObject({
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_MODEL_VERSION_PAGE_MAX_LIMIT)
      .default(V2_MODEL_VERSION_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'ModelVersionPageRequestV2' })
export type ModelVersionPageRequestV2 = z.infer<typeof ModelVersionPageRequestV2Schema>

export const ModelVersionPageV2Schema = z
  .strictObject({
    items: z.array(ModelVersionV2Schema).max(V2_MODEL_VERSION_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'ModelVersionPageV2' })
export type ModelVersionPageV2 = z.infer<typeof ModelVersionPageV2Schema>

export const ModelAliasV2Schema = z
  .strictObject({
    alias: ModelAliasNameV2Schema,
    version_id: ModelVersionIdV2Schema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  })
  .meta({ id: 'ModelAliasV2' })
export type ModelAliasV2 = z.infer<typeof ModelAliasV2Schema>

export const ModelAliasPageV2Schema = z
  .strictObject({ items: z.array(ModelAliasV2Schema).max(3) })
  .meta({ id: 'ModelAliasPageV2' })
export type ModelAliasPageV2 = z.infer<typeof ModelAliasPageV2Schema>

export const CandidateModelAliasParamsV2Schema = z
  .strictObject({ model_id: ModelIdV2Schema, alias: z.literal('candidate') })
  .meta({ id: 'CandidateModelAliasParamsV2' })

export const MoveCandidateModelAliasV2Schema = z
  .strictObject({
    expected_version_id: ModelVersionIdV2Schema.nullable(),
    new_version_id: ModelVersionIdV2Schema,
  })
  .meta({ id: 'MoveCandidateModelAliasV2' })
export type MoveCandidateModelAliasV2 = z.infer<typeof MoveCandidateModelAliasV2Schema>

export const AdoptModelDeploymentParamsV2Schema = z
  .strictObject({
    version_id: ModelVersionIdV2Schema,
    deployment_id: z.uuid(),
  })
  .meta({ id: 'AdoptModelDeploymentParamsV2' })

export const AdoptModelDeploymentRequestV2Schema = z
  .strictObject({
    expected_artifact_id: ModelArtifactIdV2Schema,
    expected_deployment_digest: DigestHexSchema,
  })
  .meta({ id: 'AdoptModelDeploymentRequestV2' })
export type AdoptModelDeploymentRequestV2 = z.infer<typeof AdoptModelDeploymentRequestV2Schema>

export const ModelDeploymentAdoptionIdentityV1Schema: z.ZodType<ModelDeploymentAdoptionIdentityV1> =
  z.strictObject({
    adoption_profile: z.literal(V2_MODEL_DEPLOYMENT_ADOPTION_PROFILE),
    namespace: IdentityNamespaceV2Schema,
    model_id: ModelIdV2Schema,
    model_version_id: ModelVersionIdV2Schema,
    deployment_id: z.uuid(),
    deployment_digest: DigestHexSchema,
    artifact_id: ModelArtifactIdV2Schema,
  })

export const ModelDeploymentAdoptionV2Schema = z
  .strictObject({
    adoption_profile: z.literal(V2_MODEL_DEPLOYMENT_ADOPTION_PROFILE),
    adoption_digest: DigestHexSchema,
    model_id: ModelIdV2Schema,
    model_version_id: ModelVersionIdV2Schema,
    deployment_id: z.uuid(),
    deployment_digest: DigestHexSchema,
    artifact_id: ModelArtifactIdV2Schema,
    adopted_at: Rfc3339UtcSchema,
    replayed: z.boolean(),
  })
  .meta({ id: 'ModelDeploymentAdoptionV2' })
export type ModelDeploymentAdoptionV2 = z.infer<typeof ModelDeploymentAdoptionV2Schema>

export function classifyModelVersionSourceV2(
  source: ModelRegistrationSourceV2,
  evidence: readonly ModelSourceEvidenceV2[] = [],
  classificationEvidenceDigest: string | null = null,
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
  const matchingVerifiedIndex = evidence.findLastIndex(
    (entry) =>
      entry.result === 'verified' &&
      entry.evidence_kind === 'provider_resolution' &&
      (source.kind === 'repository_reference' && source.revision_kind === 'tag'
        ? entry.observed_revision !== null
        : entry.observed_revision === expectedRevision) &&
      entry.response_digest !== null,
  )
  const driftIndex = evidence.findLastIndex((entry) => entry.result === 'revision_mismatch')
  const verified = matchingVerifiedIndex >= 0 && matchingVerifiedIndex > driftIndex
  const sourceIsDeclaredMutable =
    (source.kind === 'repository_reference' && source.revision_kind === 'tag') ||
    (source.kind === 'existing_service' && source.declared_reference_kind === 'mutable_alias')
  const exactRepositoryReference =
    source.kind === 'repository_reference' &&
    (source.revision_kind === 'commit' || source.revision_kind === 'digest')
  return {
    source_mutability: sourceIsDeclaredMutable
      ? 'mutable'
      : exactRepositoryReference && verified
        ? 'immutable'
        : 'unknown',
    verification_level: verified ? 'provider_verified' : 'operator_attested',
    evidence_digest: verified || driftIndex >= 0 ? classificationEvidenceDigest : null,
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
