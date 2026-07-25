import type { LegacyObjectTarget, ObjectMetadata } from './types.js'

const HEX_64 = '[0-9a-f]{64}'
const DATASET_KEY = new RegExp(`^objects/([0-9a-f]{2})/(${HEX_64})\\.(parquet|manifest\\.json)$`)
const VOCABULARY_KEY = new RegExp(`^vocabularies/([0-9a-f]{2})/(${HEX_64})\\.json$`)

export function parseLegacyObjectTarget(
  object: Readonly<ObjectMetadata>,
): Readonly<LegacyObjectTarget> | null {
  if (object.key.startsWith('objects/v2/')) return null

  const datasetMatch = DATASET_KEY.exec(object.key)
  if (datasetMatch) {
    const shard = datasetMatch[1]
    const version = datasetMatch[2]
    const suffix = datasetMatch[3]
    if (shard !== version?.slice(0, 2)) return null
    return Object.freeze({
      ...object,
      kind: suffix === 'parquet' ? 'dataset_parquet' : 'dataset_manifest',
    })
  }

  const vocabularyMatch = VOCABULARY_KEY.exec(object.key)
  if (vocabularyMatch) {
    const shard = vocabularyMatch[1]
    const id = vocabularyMatch[2]
    if (shard !== id?.slice(0, 2)) return null
    return Object.freeze({ ...object, kind: 'vocabulary_json' })
  }

  return null
}

export function isLegacyObjectPrefix(key: string): boolean {
  return key.startsWith('objects/') || key.startsWith('vocabularies/')
}

export function assertExactLegacyDeletionKey(key: string): void {
  const target = parseLegacyObjectTarget({ key, size: 0, etag: null })
  if (target === null) {
    throw new TypeError(`refusing to delete an unrecognized or protected object key: ${key}`)
  }
}
