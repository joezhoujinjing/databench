import type { Client, FetchResponse } from 'openapi-fetch'
import createClient from 'openapi-fetch'
import { getApiBaseUrl, getStoredToken, normalizeApiBase } from './config.js'
import {
  apiErrorFromBody,
  ensureJsonResponse,
  isApiError,
  networkApiError,
  responseToApiError,
} from './errors.js'
import type { paths } from './generated/schema.js'

export type OpenApiClient = Client<paths>
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type OpenApiFetchLike = (request: Request) => Promise<Response>

export interface ApiClientOptions {
  base?: string
  fetch?: OpenApiFetchLike
  token?: string
}

export interface RawRequestOptions extends Omit<RequestInit, 'headers'> {
  base?: string
  fetch?: FetchLike
  headers?: HeadersInit
  query?: Record<string, unknown>
  token?: string
}

type OpenApiResult<T> =
  | {
      data: T
      error?: never
      response: Response
    }
  | {
      data?: never
      error: unknown
      response: Response
    }

export function createApiClient(options: ApiClientOptions = {}): OpenApiClient {
  const base = normalizeApiBase(options.base ?? getApiBaseUrl())
  const token = options.token ?? getStoredToken(base)

  return createClient<paths>({
    baseUrl: base,
    fetch: createAuthorizedFetch(token, options.fetch),
    querySerializer: serializeQuery,
  })
}

export const apiClient = createApiClient()

export function createAuthorizedFetch(
  token: string,
  fetcher: OpenApiFetchLike = (request) => globalThis.fetch(request),
) {
  return async (request: Request): Promise<Response> => {
    const headers = withAuthHeader(request.headers, token)

    try {
      return await fetcher(new Request(request, { headers }))
    } catch (error) {
      throw networkApiError(error)
    }
  }
}

export async function unwrapOpenApiResponse<T>(
  result:
    | Promise<FetchResponse<Record<string | number, unknown>, unknown, `${string}/${string}`>>
    | Promise<OpenApiResult<T>>,
): Promise<T> {
  let settled: OpenApiResult<T>

  try {
    settled = (await result) as OpenApiResult<T>
  } catch (error) {
    if (isApiError(error)) {
      throw error
    }

    throw networkApiError(error)
  }

  if (settled.error !== undefined) {
    throw apiErrorFromBody(settled.response.status, settled.error)
  }

  return settled.data as T
}

export async function rawRequest(path: string, options: RawRequestOptions = {}): Promise<Response> {
  const {
    base = getApiBaseUrl(),
    fetch: fetcher = globalThis.fetch,
    headers,
    query,
    token = getStoredToken(base),
    ...init
  } = options
  const requestHeaders = withAuthHeader(headers, token)

  try {
    return await fetcher(buildUrl(base, path, query), { ...init, headers: requestHeaders })
  } catch (error) {
    throw networkApiError(error)
  }
}

export async function requestJson<T>(path: string, options: RawRequestOptions = {}): Promise<T> {
  const response = await ensureJsonResponse(await rawRequest(path, options))
  return (await response.json()) as T
}

export async function expectOkResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    throw await responseToApiError(response)
  }

  return response
}

export function buildUrl(base: string, path: string, query?: Record<string, unknown>): string {
  const pathname = path.startsWith('/') ? path : `/${path}`
  const queryString = serializeQuery(query ?? {})
  const suffix = queryString === '' ? '' : `?${queryString}`
  const normalizedBase = normalizeApiBase(base)

  if (normalizedBase === '') {
    return `${pathname}${suffix}`
  }

  const url = new URL(pathname, `${normalizedBase}/`)
  url.search = queryString
  return url.toString()
}

export function serializeQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item))
      }
      continue
    }

    params.set(key, String(value))
  }

  return params.toString()
}

function withAuthHeader(headers: HeadersInit | undefined, token: string): Headers {
  const next = new Headers(headers)
  const trimmed = token.trim()

  if (trimmed !== '') {
    next.set('Authorization', `Bearer ${trimmed}`)
  }

  return next
}
