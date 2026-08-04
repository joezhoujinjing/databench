import type {
  CatalogModelArtifactRowV2,
  CatalogModelDeploymentHealthV2,
  CatalogModelDeploymentRowV2,
  CatalogModelVersionDeploymentRowV2,
  CatalogModelVersionRowV2,
  CatalogModelVersionSourceV2,
} from '@databench/catalog'
import {
  IntegrityError,
  type ModelDeploymentV2,
  ModelDeploymentV2Schema,
  type ModelVersionDeploymentV2,
  ModelVersionDeploymentV2Schema,
  type ResolvedModelDeploymentV2,
  ResolvedModelDeploymentV2Schema,
  type ResolvedModelVersionDeploymentV2,
  ResolvedModelVersionDeploymentV2Schema,
} from '@databench/schema'

const PUBLIC_HEALTH_ERROR_CODES = new Set([
  'timeout',
  'network_error',
  'http_error',
  'invalid_response',
  'served_model_missing',
])

export interface V2ModelDeploymentHealthRequest {
  readonly deploymentId: string
  readonly endpointBaseUrl: string
  readonly servedModelName: string
}

export interface V2ModelDeploymentHealthClient {
  observe(
    request: Readonly<V2ModelDeploymentHealthRequest>,
    context?: { readonly signal?: AbortSignal },
  ): Promise<Readonly<CatalogModelDeploymentHealthV2>>
}

export const DENY_ALL_MODEL_DEPLOYMENT_HEALTH_CLIENT_V2: V2ModelDeploymentHealthClient =
  Object.freeze({
    async observe() {
      return Object.freeze({ status: 'unhealthy', error: 'network_error' })
    },
  })

export interface V2ModelVersionDeploymentRuntimeRequest {
  readonly deploymentId: string
  readonly endpointBaseUrl: string
  readonly servedModelName: string
  readonly connectivityScope: 'private_network' | 'public_network'
  readonly authProfile: 'none' | 'bearer_ref'
  readonly credentialRef: string | null
}

export interface V2ModelVersionDeploymentConfigurationV2 {
  readonly policyGeneration: number
  readonly credentialGeneration: number | null
}

export type V2ModelVersionDeploymentRuntimeErrorCode =
  | 'public_network_disabled'
  | 'policy_rejected'
  | 'credential_unavailable'
  | 'runtime_unavailable'

export type V2ModelVersionDeploymentUnavailableReason =
  | 'not_active'
  | 'public_network_disabled'
  | 'policy_generation_changed'
  | 'credential_generation_changed'
  | 'credential_unavailable'
  | 'runtime_unavailable'

export class V2ModelVersionDeploymentRuntimeError extends Error {
  readonly code: V2ModelVersionDeploymentRuntimeErrorCode

  constructor(code: V2ModelVersionDeploymentRuntimeErrorCode) {
    super('Model Version Deployment runtime admission failed')
    this.name = 'V2ModelVersionDeploymentRuntimeError'
    this.code = code
  }
}

export interface V2ModelVersionDeploymentRuntime {
  configuration(
    request: Readonly<V2ModelVersionDeploymentRuntimeRequest>,
  ): Promise<Readonly<V2ModelVersionDeploymentConfigurationV2>>
  observe(
    request: Readonly<V2ModelVersionDeploymentRuntimeRequest>,
    context?: { readonly signal?: AbortSignal },
  ): Promise<Readonly<CatalogModelDeploymentHealthV2>>
}

export const DENY_ALL_MODEL_VERSION_DEPLOYMENT_RUNTIME_V2: V2ModelVersionDeploymentRuntime =
  Object.freeze({
    async configuration() {
      throw new V2ModelVersionDeploymentRuntimeError('runtime_unavailable')
    },
    async observe() {
      return Object.freeze({ status: 'unhealthy', error: 'unhealthy' })
    },
  })

export function modelDeploymentFromCatalogV2(row: CatalogModelDeploymentRowV2): ModelDeploymentV2 {
  return ModelDeploymentV2Schema.parse({
    id: row.id,
    artifact_id: row.artifactId,
    display_name: row.displayName,
    provider: row.provider,
    registration_mode: 'operator_attested',
    served_model_name: row.servedModelName,
    auth_mode: row.authMode,
    status: row.status,
    health_status: row.healthStatus,
    health_checked_at: row.healthCheckedAt?.toISOString() ?? null,
    health_error_code:
      row.healthError === null
        ? null
        : PUBLIC_HEALTH_ERROR_CODES.has(row.healthError)
          ? row.healthError
          : 'unhealthy',
    created_at: row.createdAt.toISOString(),
    disabled_at: row.disabledAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  })
}

export function resolvedModelDeploymentFromCatalogV2(
  row: CatalogModelDeploymentRowV2,
  artifact: CatalogModelArtifactRowV2,
): ResolvedModelDeploymentV2 {
  if (
    artifact.id !== row.artifactId ||
    artifact.namespaceId !== row.namespaceId ||
    artifact.artifactKind !== 'lora_adapter' ||
    artifact.baseModelBindingStatus !== 'verified' ||
    artifact.baseModelRevision === null
  ) {
    throw new IntegrityError('Stored Model Deployment has an invalid Artifact binding', {
      reason: 'model_deployment_artifact_binding_invalid',
      deployment_id: row.id,
      artifact_id: row.artifactId,
    })
  }
  return ResolvedModelDeploymentV2Schema.parse({
    id: row.id,
    artifact_id: row.artifactId,
    create_digest: row.createDigest,
    provider: row.provider,
    registration_mode: 'operator_attested',
    served_model_name: row.servedModelName,
    endpoint_base_url: row.endpointBaseUrl,
    auth_mode: row.authMode,
    base_model_reference: artifact.baseModelReference,
    base_model_revision: artifact.baseModelRevision,
  })
}

export function modelVersionDeploymentRuntimeRequestV2(
  row: CatalogModelVersionDeploymentRowV2,
): Readonly<V2ModelVersionDeploymentRuntimeRequest> {
  return Object.freeze({
    deploymentId: row.id,
    endpointBaseUrl: row.endpointBaseUrl,
    servedModelName: row.servedModelName,
    connectivityScope: row.connectivityScope,
    authProfile: row.authProfile,
    credentialRef: row.credentialRef,
  })
}

export function modelVersionDeploymentFromCatalogV2(
  row: CatalogModelVersionDeploymentRowV2,
  availability: {
    readonly availability: 'available' | 'unavailable'
    readonly unavailableReason: V2ModelVersionDeploymentUnavailableReason | null
  },
): ModelVersionDeploymentV2 {
  return ModelVersionDeploymentV2Schema.parse({
    id: row.id,
    model_version_id: row.modelVersionId,
    display_name: row.displayName,
    provider: row.provider,
    served_model_name: row.servedModelName,
    connectivity_scope: row.connectivityScope,
    auth_profile: row.authProfile,
    declared_capabilities: {
      interfaces: row.declaredCapabilities.interfaces,
      context_limit: row.declaredCapabilities.contextLimit,
    },
    lifecycle: row.lifecycle,
    availability: availability.availability,
    unavailable_reason: availability.unavailableReason,
    health_status: row.healthStatus,
    health_checked_at: row.healthCheckedAt?.toISOString() ?? null,
    health_error_code:
      row.healthError === null
        ? null
        : PUBLIC_HEALTH_ERROR_CODES.has(row.healthError)
          ? row.healthError
          : row.healthError === 'policy_rejected' ||
              row.healthError === 'credential_rejected' ||
              row.healthError === 'configuration_changed'
            ? row.healthError
            : 'unhealthy',
    created_at: row.createdAt.toISOString(),
    activated_at: row.activatedAt?.toISOString() ?? null,
    disabled_at: row.disabledAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  })
}

export function resolvedModelVersionDeploymentFromCatalogV2(
  row: CatalogModelVersionDeploymentRowV2,
  version: CatalogModelVersionRowV2,
  source: CatalogModelVersionSourceV2,
): ResolvedModelVersionDeploymentV2 {
  if (
    row.modelVersionId !== version.id ||
    row.namespaceId !== version.namespaceId ||
    source.kind !== version.sourceKind ||
    (source.kind === 'databench_artifact'
      ? row.artifactId !== source.artifactId
      : row.artifactId !== null)
  ) {
    throw new IntegrityError('Stored Model Version Deployment source binding is invalid', {
      reason: 'model_version_deployment_source_binding_invalid',
      deployment_id: row.id,
      model_version_id: version.id,
    })
  }
  return ResolvedModelVersionDeploymentV2Schema.parse({
    id: row.id,
    model_id: version.modelId,
    model_version_id: version.id,
    create_digest: row.createDigest,
    source_fingerprint: version.sourceFingerprint,
    source_kind: source.kind,
    artifact_id: row.artifactId,
    source:
      source.kind === 'databench_artifact'
        ? {
            kind: source.kind,
            artifact_id: source.artifactId,
            artifact_kind: source.artifactKind,
            artifact_format: source.artifactFormat,
            archive_digest: source.archiveDigest,
            manifest_digest: source.manifestDigest,
          }
        : source.kind === 'repository_reference'
          ? {
              kind: source.kind,
              provider: source.provider,
              repository_id: source.repositoryId,
              revision: source.revision,
              revision_kind: source.revisionKind,
            }
          : {
              kind: source.kind,
              provider: source.provider,
              external_model_ref: source.externalModelRef,
              external_version_ref: source.externalVersionRef,
              declared_reference_kind: source.declaredReferenceKind,
            },
    provider: row.provider,
    served_model_name: row.servedModelName,
    endpoint_base_url: row.endpointBaseUrl,
    connectivity_scope: row.connectivityScope,
    auth_profile: row.authProfile,
    credential_ref: row.credentialRef,
    declared_capabilities: {
      interfaces: row.declaredCapabilities.interfaces,
      context_limit: row.declaredCapabilities.contextLimit,
    },
  })
}
