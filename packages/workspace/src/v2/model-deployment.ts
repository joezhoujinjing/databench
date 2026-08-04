import type {
  CatalogModelArtifactRowV2,
  CatalogModelDeploymentHealthV2,
  CatalogModelDeploymentRowV2,
} from '@databench/catalog'
import {
  IntegrityError,
  type ModelDeploymentV2,
  ModelDeploymentV2Schema,
  type ResolvedModelDeploymentV2,
  ResolvedModelDeploymentV2Schema,
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
