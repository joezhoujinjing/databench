import { type FetchLike, requestJson } from './client.js'
import { clampLimit } from './pagination.js'
import type { RefInfo, RefsPage } from './types.js'

export interface RefsRequestOptions {
  base: string
  fetch?: FetchLike
  limit?: number
  offset?: number
  token: string
}

export interface ResolveRefOptions {
  base: string
  fetch?: FetchLike
  name: string
  token: string
}

export function listRefs(options: RefsRequestOptions): Promise<RefsPage> {
  const { limit, offset, ...requestOptions } = options

  return requestJson<RefsPage>('/v1/refs', {
    ...requestOptions,
    query: { limit: clampLimit(limit ?? 20), offset: offset ?? 0 },
  })
}

export function resolveRef(options: ResolveRefOptions): Promise<RefInfo> {
  const { name, ...requestOptions } = options

  return requestJson<RefInfo>(`/v1/refs/${encodeURIComponent(name)}`, requestOptions)
}
