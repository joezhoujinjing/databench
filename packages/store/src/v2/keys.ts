import { type DatasetLayoutIdentityV2, DatasetLayoutIdentityV2Schema } from '@databench/schema'

export interface V2ObjectKeys {
  readonly artifact: string
  readonly manifest: string
}

export function v2ObjectKeys(input: DatasetLayoutIdentityV2): Readonly<V2ObjectKeys> {
  const identity = DatasetLayoutIdentityV2Schema.parse(input)
  const shard = identity.dataset_version.slice(0, 2)
  const base = `objects/v2/${identity.layout_version}/${shard}/${identity.dataset_version}`
  return Object.freeze({
    artifact: `${base}/${identity.artifact_digest}.parquet`,
    manifest: `${base}/manifest.json`,
  })
}
