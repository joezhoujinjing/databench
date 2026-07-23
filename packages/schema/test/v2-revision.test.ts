import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalJsonV2, hashV2Record } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import { createRecordRevisionV2, type PostTrainingRecordV2 } from '../src/index.js'

const fixturePath = fileURLToPath(
  new URL('./golden/fixtures/v2/record-revision-deep-immutable.input.json', import.meta.url),
)

describe('RecordRevisionV2', () => {
  test('defensively clones and recursively freezes one strict canonical record', () => {
    const input = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2
    const revision = createRecordRevisionV2(input)
    const originalJson = revision.record_json
    const originalDigest = revision.record_digest

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
})

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return true
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}
