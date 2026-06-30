import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from './client.js'
import type { Capabilities, HealthInfo, VersionInfo } from './types.js'

export interface MetaRequestOptions {
  base: string
  fetch?: OpenApiFetchLike
  token: string
}

export function getHealth(options: MetaRequestOptions): Promise<HealthInfo> {
  return unwrapOpenApiResponse(createApiClient(options).GET('/health'))
}

export function getVersion(options: MetaRequestOptions): Promise<VersionInfo> {
  return unwrapOpenApiResponse(createApiClient(options).GET('/version'))
}

export function getCapabilities(options: MetaRequestOptions): Promise<Capabilities> {
  return unwrapOpenApiResponse(createApiClient(options).GET('/capabilities'))
}
