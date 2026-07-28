import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from '@/api/client.js'
import type { components } from '@/api/generated/schema.js'

export type CreateSwiftStudioSessionRequestV2 =
  components['schemas']['CreateSwiftStudioSessionRequestV2']
export type SwiftStudioSessionV2 = components['schemas']['SwiftStudioSessionV2']
export type SwiftStudioSessionPageV2 = components['schemas']['SwiftStudioSessionPageV2']

interface SessionClientOptions {
  readonly base: string
  readonly fetch?: OpenApiFetchLike
  readonly signal?: AbortSignal
  readonly token: string
}

export interface ListSwiftStudioSessionsOptions extends SessionClientOptions {
  readonly cursor: string | null
  readonly limit: number
}

export interface CreateSwiftStudioSessionOptions extends SessionClientOptions {
  readonly request: CreateSwiftStudioSessionRequestV2
}

export interface SwiftStudioSessionOptions extends SessionClientOptions {
  readonly sessionId: string
}

export function listSwiftStudioSessionsV2(
  options: ListSwiftStudioSessionsOptions,
): Promise<SwiftStudioSessionPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/swift-studio-sessions', {
      ...requestOptions(options.signal),
      params: { query: { cursor: options.cursor, limit: options.limit } },
    }),
  )
}

export function createSwiftStudioSessionV2(
  options: CreateSwiftStudioSessionOptions,
): Promise<SwiftStudioSessionV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/swift-studio-sessions', {
      ...requestOptions(options.signal),
      body: options.request,
    }),
  )
}

export function getSwiftStudioSessionV2(
  options: SwiftStudioSessionOptions,
): Promise<SwiftStudioSessionV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/swift-studio-sessions/{session_id}', {
      ...requestOptions(options.signal),
      params: { path: { session_id: options.sessionId } },
    }),
  )
}

export function closeSwiftStudioSessionV2(
  options: SwiftStudioSessionOptions,
): Promise<SwiftStudioSessionV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/swift-studio-sessions/{session_id}:close', {
      ...requestOptions(options.signal),
      body: {},
      params: { path: { session_id: options.sessionId } },
    }),
  )
}

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
