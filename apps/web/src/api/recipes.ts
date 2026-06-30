import { type FetchLike, requestJson } from './client.js'
import type { DatasetManifest, MaterializeRequest } from './types.js'

export interface MaterializeRecipeOptions {
  base: string
  fetch?: FetchLike
  payload: MaterializeRequest
  token: string
}

export function materializeRecipe(options: MaterializeRecipeOptions): Promise<DatasetManifest> {
  const { payload, ...requestOptions } = options

  return requestJson<DatasetManifest>('/v1/recipes:materialize', {
    ...requestOptions,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}
