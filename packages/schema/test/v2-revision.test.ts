import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalJsonV2, hashV2DatasetIdentity, hashV2Record } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  createRecordRevisionV2,
  datasetVersionForSortedRecordRevisionsV2,
  isRecordRevisionV2,
  type PostTrainingRecordV2,
} from '../src/index.js'

const fixturePath = fileURLToPath(
  new URL('./golden/fixtures/v2/record-revision-deep-immutable.input.json', import.meta.url),
)

describe('RecordRevisionV2', () => {
  test('defensively clones and recursively freezes one strict canonical record', () => {
    const input = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2
    const revision = createRecordRevisionV2(input)
    const originalJson = revision.record_json
    const originalDigest = revision.record_digest

    expect(isRecordRevisionV2(revision)).toBe(true)
    expect(revision.record_json).toBe(canonicalJsonV2(revision.record))
    expect(revision.record_digest).toBe(hashV2Record(revision.record))
    expect(isDeepFrozen(revision)).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)

    input.tags.push('caller-mutation')
    Reflect.set(input.extra.deep as object, 'changed', true)
    expect(revision.record.tags).not.toContain('caller-mutation')
    expect(revision.record_json).toBe(originalJson)
    expect(revision.record_digest).toBe(originalDigest)

    expect(() => revision.record.tags.push('revision-mutation')).toThrow(TypeError)
    const nested = revision.record.extra.deep as { readonly array: readonly object[] }
    expect(Reflect.set(nested.array[0] as object, 'value', 'changed')).toBe(false)
    expect(revision.record_json).toBe(originalJson)
    expect(revision.record_digest).toBe(originalDigest)
  })

  test('rejects non-strict or non-cloneable inputs before hashing', () => {
    const input = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2
    expect(() => createRecordRevisionV2({ ...input, unknown: true })).toThrow()
    expect(() => createRecordRevisionV2({ ...input, extra: { value: undefined } })).toThrow()
    expect(() => createRecordRevisionV2({ ...input, extra: { value: 1n } })).toThrow()
  })

  test('recognizes only revisions carrying the package-private runtime brand', () => {
    const input = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2
    const revision = createRecordRevisionV2(input)
    const forged = {
      record: revision.record,
      record_json: revision.record_json,
      record_digest: revision.record_digest,
    }

    expect(isRecordRevisionV2(forged)).toBe(false)
    expect(isRecordRevisionV2({ ...revision })).toBe(false)
    expect(isRecordRevisionV2(new Proxy(revision, {}))).toBe(false)
    expect(isRecordRevisionV2(null)).toBe(false)
  })

  test('computes exact dataset identity from sorted revisions with constant-memory hashing', () => {
    const input = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2
    const first = createRecordRevisionV2(input)
    const second = createRecordRevisionV2({ ...input, id: `rec_${'b'.repeat(64)}` })
    const sorted = [first, second].sort((left, right) =>
      left.record_digest === right.record_digest
        ? left.record.id.localeCompare(right.record.id)
        : left.record_digest.localeCompare(right.record_digest),
    )
    const expected = hashV2DatasetIdentity({
      identity_profile: 'databench-v2-jcs-1',
      record_schema_version: '2.0.0',
      record_digests: sorted.map((revision) => revision.record_digest),
    })

    expect(datasetVersionForSortedRecordRevisionsV2(sorted)).toBe(expected)
    expect(() => datasetVersionForSortedRecordRevisionsV2([...sorted].reverse())).toThrow(TypeError)
  })
})

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return true
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}
