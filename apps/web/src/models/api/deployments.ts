import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from '@/api/client.js'
import type { components } from '@/api/generated/schema.js'

export type CreateModelDeploymentRequestV2 = components['schemas']['CreateModelDeploymentRequestV2']
export type ModelDeploymentPageV2 = components['schemas']['ModelDeploymentPageV2']
export type ModelDeploymentV2 = components['schemas']['ModelDeploymentV2']
export type EvaluationRunPageV2 = components['schemas']['EvaluationRunPageV2']
export type EvaluationRunV2 = components['schemas']['EvaluationRunV2']

interface DeploymentClientOptions {
  readonly base: string
  readonly fetch?: OpenApiFetchLike
  readonly signal?: AbortSignal
  readonly token: string
}

export interface ListModelDeploymentsOptions extends DeploymentClientOptions {
  readonly artifactId?: string
  readonly cursor: string | null
  readonly limit: number
  readonly status?: ModelDeploymentV2['status']
}

export interface CreateModelDeploymentOptions extends DeploymentClientOptions {
  readonly request: CreateModelDeploymentRequestV2
}

export interface ModelDeploymentActionOptions extends DeploymentClientOptions {
  readonly deploymentId: string
}

export interface ListDeploymentEvaluationRunsOptions extends DeploymentClientOptions {
  readonly deploymentId: string
  readonly cursor: string | null
  readonly limit: number
}

export function listModelDeploymentsV2(
  options: ListModelDeploymentsOptions,
): Promise<ModelDeploymentPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-deployments', {
      ...requestOptions(options.signal),
      params: {
        query: {
          ...(options.artifactId === undefined ? {} : { artifact_id: options.artifactId }),
          ...(options.status === undefined ? {} : { status: options.status }),
          cursor: options.cursor,
          limit: options.limit,
        },
      },
    }),
  )
}

export function createModelDeploymentV2(
  options: CreateModelDeploymentOptions,
): Promise<ModelDeploymentV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-deployments', {
      ...requestOptions(options.signal),
      body: options.request,
    }),
  )
}

export function checkModelDeploymentV2(
  options: ModelDeploymentActionOptions,
): Promise<ModelDeploymentV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-deployments/{deployment_id}:check', {
      ...requestOptions(options.signal),
      body: {},
      params: { path: { deployment_id: options.deploymentId } },
    }),
  )
}

export function disableModelDeploymentV2(
  options: ModelDeploymentActionOptions,
): Promise<ModelDeploymentV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-deployments/{deployment_id}:disable', {
      ...requestOptions(options.signal),
      body: {},
      params: { path: { deployment_id: options.deploymentId } },
    }),
  )
}

export function listDeploymentEvaluationRunsV2(
  options: ListDeploymentEvaluationRunsOptions,
): Promise<EvaluationRunPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/evaluation-runs', {
      ...requestOptions(options.signal),
      params: {
        query: {
          model_deployment_id: options.deploymentId,
          cursor: options.cursor,
          limit: options.limit,
        },
      },
    }),
  )
}

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
