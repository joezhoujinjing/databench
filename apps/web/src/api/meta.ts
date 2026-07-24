import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from './client.js'
import type { Capabilities, HealthInfo, VersionInfo } from './types.js'

export interface MetaRequestOptions {
  base: string
  fetch?: OpenApiFetchLike
  signal?: AbortSignal
  token: string
}

export function getHealth(options: MetaRequestOptions): Promise<HealthInfo> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/health', requestOptions(options.signal)),
  )
}

export function getVersion(options: MetaRequestOptions): Promise<VersionInfo> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/version', requestOptions(options.signal)),
  )
}

export function getCapabilities(options: MetaRequestOptions): Promise<Capabilities> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/capabilities', requestOptions(options.signal)),
  )
}

function requestOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
