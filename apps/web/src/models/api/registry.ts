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
        },
      },
    }),
  )
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

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
