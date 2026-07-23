import { classifyError, type DatasetLayoutIdentityV2 } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { LayoutConflictErrorV2, ObjectStoreFailureErrorV2 } from '../src/v2/contracts.js'
import { v2ObjectKeys } from '../src/v2/keys.js'

const datasetVersion = `01${'a'.repeat(62)}`
const artifactDigest = 'b'.repeat(64)

const identity: DatasetLayoutIdentityV2 = {
  identity_profile: 'databench-v2-jcs-1',
  record_schema_version: '2.0.0',
  dataset_version: datasetVersion,
  num_records: 2,
  layout_version: 'record-json-v1',
  artifact_digest: artifactDigest,
  artifact_size_bytes: 123,
}

describe('v2 object keys', () => {
  test('builds the exact artifact and unique manifest commit-point keys', () => {
    const keys = v2ObjectKeys(identity)

    expect(keys).toEqual({
      artifact: `objects/v2/record-json-v1/01/${datasetVersion}/${artifactDigest}.parquet`,
      manifest: `objects/v2/record-json-v1/01/${datasetVersion}/manifest.json`,
    })
    expect(Object.isFrozen(keys)).toBe(true)
  })

  test('changes only the artifact key when the artifact digest changes', () => {
    const first = v2ObjectKeys(identity)
    const second = v2ObjectKeys({ ...identity, artifact_digest: 'c'.repeat(64) })

    expect(second.artifact).not.toBe(first.artifact)
    expect(second.manifest).toBe(first.manifest)
  })

  test.each([
    ['uppercase dataset version', { dataset_version: datasetVersion.toUpperCase() }],
    ['short artifact digest', { artifact_digest: artifactDigest.slice(1) }],
    ['layout traversal', { layout_version: '../record-json-v1' }],
    ['negative artifact size', { artifact_size_bytes: -1 }],
    ['unsafe record count', { num_records: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s before constructing a key', (_name, override) => {
    expect(() =>
      v2ObjectKeys({
        ...identity,
        ...override,
      } as DatasetLayoutIdentityV2),
    ).toThrow()
  })
})

describe('v2 store error taxonomy', () => {
  test('keeps layout conflict as HTTP-agnostic conflict class with its precise wire code', () => {
    const error = new LayoutConflictErrorV2()

    expect(error.code).toBe('layout_conflict')
    expect(error.detail).toEqual({ reason: 'layout_conflict' })
    expect(classifyError(error)).toBe('conflict')
  })

  test('classifies unresolved provider failures as service unavailable', () => {
    const cause = new Error('socket reset')
    const error = new ObjectStoreFailureErrorV2('Object-store result is ambiguous', cause, 'oss')

    expect(error.code).toBe('service_unavailable')
    expect(error.detail).toEqual({ provider: 'oss' })
    expect(error.cause).toBe(cause)
    expect(classifyError(error)).toBe('service_unavailable')
  })
})
