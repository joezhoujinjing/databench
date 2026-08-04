import { TextEncoder } from 'node:util'
import { digest } from '../blake3.js'
import { canonicalJsonV2 } from './canonical-json.js'

export const V2_MODEL_CREATE_PROFILE = 'model-create-v1' as const
export const V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE =
  'model-source-fingerprint-artifact-v1' as const
export const V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE =
  'model-source-fingerprint-repository-v1' as const
export const V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE =
  'model-source-fingerprint-service-v1' as const
export const V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE = 'model-version-create-artifact-v1' as const
export const V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE =
  'model-version-create-repository-v1' as const
export const V2_MODEL_VERSION_CREATE_SERVICE_PROFILE = 'model-version-create-service-v1' as const
export const V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE =
  'model-registration-plan-artifact-v1' as const
export const V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE =
  'model-registration-plan-repository-v1' as const
export const V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE =
  'model-registration-plan-service-v1' as const
export const V2_MODEL_DEPLOYMENT_ADOPTION_PROFILE = 'model-deployment-adoption-v1' as const

const DOMAIN = {
  modelCreate: 'databench.model-create.model-create-v1\0',
  sourceArtifact: 'databench.model-source-fingerprint.model-source-fingerprint-artifact-v1\0',
  sourceRepository: 'databench.model-source-fingerprint.model-source-fingerprint-repository-v1\0',
  sourceService: 'databench.model-source-fingerprint.model-source-fingerprint-service-v1\0',
  versionArtifact: 'databench.model-version-create.model-version-create-artifact-v1\0',
  versionRepository: 'databench.model-version-create.model-version-create-repository-v1\0',
  versionService: 'databench.model-version-create.model-version-create-service-v1\0',
  registrationArtifact: 'databench.model-registration-plan.model-registration-plan-artifact-v1\0',
  registrationRepository:
    'databench.model-registration-plan.model-registration-plan-repository-v1\0',
  registrationService: 'databench.model-registration-plan.model-registration-plan-service-v1\0',
  deploymentAdoption: 'databench.model-deployment-adoption.model-deployment-adoption-v1\0',
} as const

const textEncoder = new TextEncoder()
const HEX_64 = /^[0-9a-f]{64}$/

export type ModelSourceMutabilityV2 = 'immutable' | 'mutable' | 'unknown'
export type ModelVerificationLevelV2 =
  | 'content_verified'
  | 'provider_verified'
  | 'operator_attested'
  | 'unverified'

export interface ModelCreateIdentityV1 {
  readonly model_create_profile: typeof V2_MODEL_CREATE_PROFILE
  readonly namespace: string
  readonly key: string
}

export interface ModelSourceFingerprintArtifactIdentityV1 {
  readonly source_fingerprint_profile: typeof V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE
  readonly artifact_id: string
  readonly artifact_kind: string
  readonly artifact_format: string
  readonly archive_digest: string
  readonly manifest_digest: string
}

export interface ModelSourceFingerprintRepositoryIdentityV1 {
  readonly source_fingerprint_profile: typeof V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE
  readonly provider: 'hugging_face' | 'modelscope' | 'operator_managed'
  readonly repository_id: string
  readonly revision: string
  readonly revision_kind: 'commit' | 'digest' | 'tag' | 'opaque'
}

export interface ModelSourceFingerprintServiceIdentityV1 {
  readonly source_fingerprint_profile: typeof V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE
  readonly provider: 'openai_compatible'
  readonly external_model_ref: string
  readonly external_version_ref: string
  readonly declared_reference_kind: 'immutable_version' | 'mutable_alias' | 'opaque'
}

interface ModelVersionCreateIdentityBaseV1 {
  readonly namespace: string
  readonly model_id: string
  readonly version_label: string
  readonly source_fingerprint: string
}

export interface ModelVersionCreateArtifactIdentityV1 extends ModelVersionCreateIdentityBaseV1 {
  readonly model_version_create_profile: typeof V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE
  readonly base_model_reference: string
  readonly base_model_revision: string | null
  readonly base_model_binding_status: 'verified' | 'declared' | 'unresolved'
}

export interface ModelVersionCreateRepositoryIdentityV1 extends ModelVersionCreateIdentityBaseV1 {
  readonly model_version_create_profile: typeof V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE
  readonly base_model_reference: string | null
  readonly base_model_revision: string | null
}

export interface ModelVersionCreateServiceIdentityV1 extends ModelVersionCreateIdentityBaseV1 {
  readonly model_version_create_profile: typeof V2_MODEL_VERSION_CREATE_SERVICE_PROFILE
  readonly base_model_reference: string | null
  readonly base_model_revision: string | null
}

interface ModelRegistrationPlanIdentityBaseV1 {
  readonly namespace: string
  readonly normalized_request: object
  readonly model_id: string
  readonly model_create_digest: string | null
  readonly source_fingerprint: string
  readonly version_create_digest: string
  readonly classification: {
    readonly source_mutability: ModelSourceMutabilityV2
    readonly verification_level: ModelVerificationLevelV2
    readonly evidence_digest: string | null
  }
}

export interface ModelRegistrationPlanArtifactIdentityV1
  extends ModelRegistrationPlanIdentityBaseV1 {
  readonly plan_profile: typeof V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE
}

export interface ModelRegistrationPlanRepositoryIdentityV1
  extends ModelRegistrationPlanIdentityBaseV1 {
  readonly plan_profile: typeof V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE
}

export interface ModelRegistrationPlanServiceIdentityV1
  extends ModelRegistrationPlanIdentityBaseV1 {
  readonly plan_profile: typeof V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE
}

export interface ModelDeploymentAdoptionIdentityV1 {
  readonly adoption_profile: typeof V2_MODEL_DEPLOYMENT_ADOPTION_PROFILE
  readonly namespace: string
  readonly model_id: string
  readonly model_version_id: string
  readonly deployment_id: string
  readonly deployment_digest: string
  readonly artifact_id: string
}

type NoExtraKeys<Expected, Actual extends Expected> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>

export function hashV2ModelCreate<const Identity extends ModelCreateIdentityV1>(
  identity: NoExtraKeys<ModelCreateIdentityV1, Identity>,
): string {
  return hashDomain(DOMAIN.modelCreate, {
    model_create_profile: identity.model_create_profile,
    namespace: identity.namespace,
    key: identity.key,
  })
}

export function hashV2ModelSourceFingerprintArtifact<
  const Identity extends ModelSourceFingerprintArtifactIdentityV1,
>(identity: NoExtraKeys<ModelSourceFingerprintArtifactIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.sourceArtifact, {
    source_fingerprint_profile: identity.source_fingerprint_profile,
    artifact_id: identity.artifact_id,
    artifact_kind: identity.artifact_kind,
    artifact_format: identity.artifact_format,
    archive_digest: identity.archive_digest,
    manifest_digest: identity.manifest_digest,
  })
}

export function hashV2ModelSourceFingerprintRepository<
  const Identity extends ModelSourceFingerprintRepositoryIdentityV1,
>(identity: NoExtraKeys<ModelSourceFingerprintRepositoryIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.sourceRepository, {
    source_fingerprint_profile: identity.source_fingerprint_profile,
    provider: identity.provider,
    repository_id: identity.repository_id,
    revision: identity.revision,
    revision_kind: identity.revision_kind,
  })
}

export function hashV2ModelSourceFingerprintService<
  const Identity extends ModelSourceFingerprintServiceIdentityV1,
>(identity: NoExtraKeys<ModelSourceFingerprintServiceIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.sourceService, {
    source_fingerprint_profile: identity.source_fingerprint_profile,
    provider: identity.provider,
    external_model_ref: identity.external_model_ref,
    external_version_ref: identity.external_version_ref,
    declared_reference_kind: identity.declared_reference_kind,
  })
}

export function hashV2ModelVersionCreateArtifact<
  const Identity extends ModelVersionCreateArtifactIdentityV1,
>(identity: NoExtraKeys<ModelVersionCreateArtifactIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.versionArtifact, {
    model_version_create_profile: identity.model_version_create_profile,
    namespace: identity.namespace,
    model_id: identity.model_id,
    version_label: identity.version_label,
    source_fingerprint: identity.source_fingerprint,
    base_model_reference: identity.base_model_reference,
    base_model_revision: identity.base_model_revision,
    base_model_binding_status: identity.base_model_binding_status,
  })
}

export function hashV2ModelVersionCreateRepository<
  const Identity extends ModelVersionCreateRepositoryIdentityV1,
>(identity: NoExtraKeys<ModelVersionCreateRepositoryIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.versionRepository, {
    model_version_create_profile: identity.model_version_create_profile,
    namespace: identity.namespace,
    model_id: identity.model_id,
    version_label: identity.version_label,
    source_fingerprint: identity.source_fingerprint,
    base_model_reference: identity.base_model_reference,
    base_model_revision: identity.base_model_revision,
  })
}

export function hashV2ModelVersionCreateService<
  const Identity extends ModelVersionCreateServiceIdentityV1,
>(identity: NoExtraKeys<ModelVersionCreateServiceIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.versionService, {
    model_version_create_profile: identity.model_version_create_profile,
    namespace: identity.namespace,
    model_id: identity.model_id,
    version_label: identity.version_label,
    source_fingerprint: identity.source_fingerprint,
    base_model_reference: identity.base_model_reference,
    base_model_revision: identity.base_model_revision,
  })
}

export function hashV2ModelRegistrationPlanArtifact<
  const Identity extends ModelRegistrationPlanArtifactIdentityV1,
>(identity: NoExtraKeys<ModelRegistrationPlanArtifactIdentityV1, Identity>): string {
  return hashRegistrationPlan(DOMAIN.registrationArtifact, identity)
}

export function hashV2ModelRegistrationPlanRepository<
  const Identity extends ModelRegistrationPlanRepositoryIdentityV1,
>(identity: NoExtraKeys<ModelRegistrationPlanRepositoryIdentityV1, Identity>): string {
  return hashRegistrationPlan(DOMAIN.registrationRepository, identity)
}

export function hashV2ModelRegistrationPlanService<
  const Identity extends ModelRegistrationPlanServiceIdentityV1,
>(identity: NoExtraKeys<ModelRegistrationPlanServiceIdentityV1, Identity>): string {
  return hashRegistrationPlan(DOMAIN.registrationService, identity)
}

export function hashV2ModelDeploymentAdoption<
  const Identity extends ModelDeploymentAdoptionIdentityV1,
>(identity: NoExtraKeys<ModelDeploymentAdoptionIdentityV1, Identity>): string {
  return hashDomain(DOMAIN.deploymentAdoption, {
    adoption_profile: identity.adoption_profile,
    namespace: identity.namespace,
    model_id: identity.model_id,
    model_version_id: identity.model_version_id,
    deployment_id: identity.deployment_id,
    deployment_digest: identity.deployment_digest,
    artifact_id: identity.artifact_id,
  })
}

export function deriveV2ModelIdFromCreateDigest(createDigest: string): string {
  return uuidV8FromDigest(createDigest)
}

export function deriveV2ModelVersionIdFromCreateDigest(createDigest: string): string {
  return uuidV8FromDigest(createDigest)
}

function hashRegistrationPlan(
  domain: string,
  identity:
    | ModelRegistrationPlanArtifactIdentityV1
    | ModelRegistrationPlanRepositoryIdentityV1
    | ModelRegistrationPlanServiceIdentityV1,
): string {
  return hashDomain(domain, {
    plan_profile: identity.plan_profile,
    namespace: identity.namespace,
    normalized_request: identity.normalized_request,
    model_id: identity.model_id,
    model_create_digest: identity.model_create_digest,
    source_fingerprint: identity.source_fingerprint,
    version_create_digest: identity.version_create_digest,
    classification: identity.classification,
  })
}

function uuidV8FromDigest(value: string): string {
  if (!HEX_64.test(value)) throw new TypeError('Model create digest must be lowercase 64-hex')
  const hex = [...value.slice(0, 32)]
  hex[12] = '8'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex
    .slice(12, 16)
    .join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

function hashDomain(domain: string, value: unknown): string {
  return digest(textEncoder.encode(`${domain}${canonicalJsonV2(value)}`))
}
