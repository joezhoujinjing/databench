import { describe, expect, test } from 'vitest'
import { assertExactLegacyDeletionKey, parseLegacyObjectTarget } from '../src/legacy-keys.js'

const version = 'ab'.repeat(32)

describe('legacy key parser', () => {
  test('accepts only exact v1 dataset and vocabulary keys', () => {
    expect(
      parseLegacyObjectTarget({
        key: `objects/ab/${version}.parquet`,
        size: 12,
        etag: 'etag',
      }),
    ).toMatchObject({ kind: 'dataset_parquet' })
    expect(
      parseLegacyObjectTarget({
        key: `objects/ab/${version}.manifest.json`,
        size: 12,
        etag: null,
      }),
    ).toMatchObject({ kind: 'dataset_manifest' })
    expect(
      parseLegacyObjectTarget({
        key: `vocabularies/ab/${version}.json`,
        size: 12,
        etag: null,
      }),
    ).toMatchObject({ kind: 'vocabulary_json' })
  })

  test('rejects v2, wrong shard, traversal and fuzzy legacy matches', () => {
    const rejected = [
      `objects/v2/record-json-v1/ab/${version}/manifest.json`,
      `objects/ff/${version}.parquet`,
      `objects/ab/${version}.parquet.backup`,
      `objects/../ab/${version}.parquet`,
      `vocabularies/ff/${version}.json`,
      `other/ab/${version}.parquet`,
    ]
    for (const key of rejected) {
      expect(parseLegacyObjectTarget({ key, size: 0, etag: null })).toBeNull()
      expect(() => assertExactLegacyDeletionKey(key)).toThrow()
    }
  })
})
