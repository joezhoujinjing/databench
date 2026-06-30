import { type FetchLike, requestJson } from './client.js'
import { clampLimit } from './pagination.js'
import type { DatasetManifest, TransformRunRequest, TransformsPage } from './types.js'

export interface TransformsRequestOptions {
  base: string
  fetch?: FetchLike
  limit?: number
  offset?: number
  token: string
}

export interface RunTransformOptions {
  base: string
  fetch?: FetchLike
  name: string
  payload: TransformRunRequest
  token: string
}

export function listTransforms(options: TransformsRequestOptions): Promise<TransformsPage> {
  const { limit, offset, ...requestOptions } = options

  return requestJson<TransformsPage>('/v1/transforms', {
    ...requestOptions,
    query: { limit: clampLimit(limit ?? 500), offset: offset ?? 0 },
  })
}

export function runTransform(options: RunTransformOptions): Promise<DatasetManifest> {
  const { name, payload, ...requestOptions } = options

  return requestJson<DatasetManifest>(`/v1/transforms/${encodeURIComponent(name)}/run`, {
    ...requestOptions,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}
