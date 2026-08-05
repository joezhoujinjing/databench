import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from '@/api/client.js'
import type { components, paths } from '@/api/generated/schema.js'

export type ModelV2 = components['schemas']['ModelV2']
export type ModelPageV2 = components['schemas']['ModelPageV2']
export type ModelVersionV2 = components['schemas']['ModelVersionV2']
export type ModelVersionPageV2 = components['schemas']['ModelVersionPageV2']
export type ModelAliasPageV2 = components['schemas']['ModelAliasPageV2']
export type ModelRegistrationCommitResultV2 =
  components['schemas']['ModelRegistrationCommitResultV2']
export type ModelRegistrationRequestV2 = components['schemas']['ModelRegistryRegistrationRequestV2']
export type ModelRegistrationCommitV2 =
  components['schemas']['CommitModelRegistryRegistrationRequestV2']
export type ModelRegistrationPlanV2 =
  paths['/v2/model-registrations:inspect']['post']['responses'][200]['content']['application/json']
export type ModelVersionDeploymentV2 = components['schemas']['ModelVersionDeploymentV2']
export type ModelVersionDeploymentPageV2 = components['schemas']['ModelVersionDeploymentPageV2']
export type ModelEvaluationDeploymentSelectorV2 =
  components['schemas']['ModelEvaluationDeploymentSelectorV2']
export type ModelDeploymentAdoptionPageV2 = components['schemas']['ModelDeploymentAdoptionPageV2']
export type EvaluationRunPageV2 = components['schemas']['EvaluationRunPageV2']

interface RegistryClientOptions {
  readonly base: string
  readonly fetch?: OpenApiFetchLike
  readonly signal?: AbortSignal
  readonly token: string
}

export interface ListModelsOptions extends RegistryClientOptions {
  readonly archive: 'active' | 'archived' | 'all'
  readonly cursor: string | null
  readonly limit: number
  readonly search: string
  readonly sourceKind?: 'databench_artifact' | 'repository_reference' | 'existing_service'
  readonly sourceMutability?: 'immutable' | 'mutable' | 'unknown'
  readonly verificationLevel?:
    | 'content_verified'
    | 'provider_verified'
    | 'operator_attested'
    | 'unverified'
  readonly taskFamily?: string
  readonly artifactKind?: 'lora_adapter'
  readonly artifactId?: string
  readonly alias?: 'candidate' | 'none'
  readonly deploymentLifecycle?: 'registered' | 'active' | 'disabled'
  readonly deploymentHealth?: 'unknown' | 'healthy' | 'unhealthy'
  readonly tag?: string
}

export function listModelsV2(options: ListModelsOptions): Promise<ModelPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/models', {
      ...requestOptions(options.signal),
      params: {
        query: {
          archive: options.archive,
          cursor: options.cursor,
          limit: options.limit,
          search: options.search,
          ...(options.sourceKind === undefined ? {} : { source_kind: options.sourceKind }),
          ...(options.sourceMutability === undefined
            ? {}
            : { source_mutability: options.sourceMutability }),
          ...(options.verificationLevel === undefined
            ? {}
            : { verification_level: options.verificationLevel }),
          ...(options.taskFamily === undefined ? {} : { task_family: options.taskFamily }),
          ...(options.artifactKind === undefined ? {} : { artifact_kind: options.artifactKind }),
          ...(options.artifactId === undefined ? {} : { artifact_id: options.artifactId }),
          ...(options.alias === undefined ? {} : { alias: options.alias }),
          ...(options.deploymentLifecycle === undefined
            ? {}
            : { deployment_lifecycle: options.deploymentLifecycle }),
          ...(options.deploymentHealth === undefined
            ? {}
            : { deployment_health: options.deploymentHealth }),
          ...(options.tag === undefined ? {} : { tag: options.tag }),
        },
      },
    }),
  )
}

export async function findModelSummaryV2(
  options: RegistryClientOptions & { readonly modelId: string; readonly modelKey: string },
): Promise<ModelPageV2['items'][number] | null> {
  let cursor: string | null = null
  const visitedCursors = new Set<string>()
  do {
    const page = await listModelsV2({
      ...options,
      archive: 'all',
      cursor,
      limit: 100,
      search: options.modelKey,
    })
    const exact = page.items.find((item) => item.model.id === options.modelId)
    if (exact !== undefined) return exact
    cursor = page.next_cursor
    if (cursor !== null) {
      if (visitedCursors.has(cursor)) throw new Error('Model summary pagination cursor repeated')
      visitedCursors.add(cursor)
    }
  } while (cursor !== null)
  return null
}

export function getModelV2(
  options: RegistryClientOptions & { readonly modelId: string },
): Promise<ModelV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/models/{model_id}', {
      ...requestOptions(options.signal),
      params: { path: { model_id: options.modelId } },
    }),
  )
}

export function restoreModelV2(
  options: RegistryClientOptions & {
    readonly modelId: string
    readonly expectedMetadataRevision: number
  },
): Promise<ModelV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/models/{model_id}:restore', {
      ...requestOptions(options.signal),
      params: { path: { model_id: options.modelId } },
      body: { expected_metadata_revision: options.expectedMetadataRevision },
    }),
  )
}

export function listModelVersionsV2(
  options: RegistryClientOptions & {
    readonly cursor: string | null
    readonly limit: number
    readonly modelId: string
  },
): Promise<ModelVersionPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/models/{model_id}/versions', {
      ...requestOptions(options.signal),
      params: {
        path: { model_id: options.modelId },
        query: { cursor: options.cursor, limit: options.limit },
      },
    }),
  )
}

export function getModelVersionV2(
  options: RegistryClientOptions & { readonly versionId: string },
): Promise<ModelVersionV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-versions/{version_id}', {
      ...requestOptions(options.signal),
      params: { path: { version_id: options.versionId } },
    }),
  )
}

export function listModelAliasesV2(
  options: RegistryClientOptions & { readonly modelId: string },
): Promise<ModelAliasPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/models/{model_id}/aliases', {
      ...requestOptions(options.signal),
      params: { path: { model_id: options.modelId } },
    }),
  )
}

export function inspectModelRegistrationV2(
  options: RegistryClientOptions & { readonly request: ModelRegistrationRequestV2 },
): Promise<ModelRegistrationPlanV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-registrations:inspect', {
      ...requestOptions(options.signal),
      body: options.request,
    }),
  )
}

export function commitModelRegistrationV2(
  options: RegistryClientOptions & { readonly request: ModelRegistrationCommitV2 },
): Promise<ModelRegistrationCommitResultV2> {
  const target = options.request.request.target
  if (target.kind === 'create_model') {
    return unwrapOpenApiResponse(
      createApiClient(options).POST('/v2/models:register', {
        ...requestOptions(options.signal),
        body: options.request,
      }),
    )
  }
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/models/{model_id}/versions:register', {
      ...requestOptions(options.signal),
      params: { path: { model_id: target.model_id } },
      body: options.request,
    }),
  )
}

export function refreshModelSourceEvidenceV2(
  options: RegistryClientOptions & { readonly versionId: string },
): Promise<ModelVersionV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-versions/{version_id}:refresh-source-evidence', {
      ...requestOptions(options.signal),
      params: { path: { version_id: options.versionId } },
      body: {},
    }),
  )
}

export function listModelVersionDeploymentsV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly lifecycle?: 'registered' | 'active' | 'disabled'
    readonly cursor?: string | null
    readonly limit?: number
  },
): Promise<ModelVersionDeploymentPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-versions/{version_id}/deployments', {
      ...requestOptions(options.signal),
      params: {
        path: { version_id: options.versionId },
        query: {
          cursor: options.cursor ?? null,
          limit: options.limit ?? 100,
          ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        },
      },
    }),
  )
}

export function listModelEvaluationDeploymentCandidatesV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly workloadProfile?: 'evalscope_chat_completions_v1'
    readonly maxOutputTokens?: number
    readonly cursor?: string | null
    readonly limit?: number
  },
): Promise<ModelEvaluationDeploymentSelectorV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-versions/{version_id}/evaluation-deployments', {
      ...requestOptions(options.signal),
      params: {
        path: { version_id: options.versionId },
        query: {
          workload_profile: options.workloadProfile ?? 'evalscope_chat_completions_v1',
          cursor: options.cursor ?? null,
          limit: options.limit ?? 100,
          ...(options.maxOutputTokens === undefined
            ? {}
            : { max_output_tokens: options.maxOutputTokens }),
        },
      },
    }),
  )
}

export function listModelDeploymentAdoptionsV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly cursor?: string | null
    readonly limit?: number
  },
): Promise<ModelDeploymentAdoptionPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-versions/{version_id}/deployment-adoptions', {
      ...requestOptions(options.signal),
      params: {
        path: { version_id: options.versionId },
        query: { cursor: options.cursor ?? null, limit: options.limit ?? 100 },
      },
    }),
  )
}

export function listModelEvaluationRunsV2(
  options: RegistryClientOptions & {
    readonly modelId: string
    readonly modelVersionId?: string
    readonly cursor?: string | null
    readonly limit?: number
  },
): Promise<EvaluationRunPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/evaluation-runs', {
      ...requestOptions(options.signal),
      params: {
        query: {
          cursor: options.cursor ?? null,
          limit: options.limit ?? 100,
          model_id: options.modelId,
          ...(options.modelVersionId === undefined
            ? {}
            : { model_version_id: options.modelVersionId }),
        },
      },
    }),
  )
}

export function activateModelVersionDeploymentV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly deploymentId: string
  },
): Promise<ModelVersionDeploymentV2> {
  return modelVersionDeploymentAction(options, 'activate')
}

export function checkModelVersionDeploymentV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly deploymentId: string
  },
): Promise<ModelVersionDeploymentV2> {
  return modelVersionDeploymentAction(options, 'check')
}

export function disableModelVersionDeploymentV2(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly deploymentId: string
  },
): Promise<ModelVersionDeploymentV2> {
  return modelVersionDeploymentAction(options, 'disable')
}

function modelVersionDeploymentAction(
  options: RegistryClientOptions & {
    readonly versionId: string
    readonly deploymentId: string
  },
  action: 'activate' | 'check' | 'disable',
): Promise<ModelVersionDeploymentV2> {
  const client = createApiClient(options)
  const params = {
    path: { version_id: options.versionId, deployment_id: options.deploymentId },
  }
  const request = { ...requestOptions(options.signal), body: {}, params }
  if (action === 'activate') {
    return unwrapOpenApiResponse(
      client.POST('/v2/model-versions/{version_id}/deployments/{deployment_id}:activate', request),
    )
  }
  if (action === 'check') {
    return unwrapOpenApiResponse(
      client.POST('/v2/model-versions/{version_id}/deployments/{deployment_id}:check', request),
    )
  }
  return unwrapOpenApiResponse(
    client.POST('/v2/model-versions/{version_id}/deployments/{deployment_id}:disable', request),
  )
}

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
