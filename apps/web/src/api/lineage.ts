import { type FetchLike, requestJson } from './client.js'
import type { Lineage } from './types.js'

export interface LineageRequestOptions {
  base: string
  fetch?: FetchLike
  ref: string
  token: string
}

export function getLineage(options: LineageRequestOptions): Promise<Lineage> {
  const { ref, ...requestOptions } = options

  return requestJson<Lineage>(`/v1/lineage/${encodeURIComponent(ref)}`, requestOptions)
}
