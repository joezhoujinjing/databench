import { canonicalJsonV2 } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  canonicalDatasetManifestV2Bytes,
  classifyError,
  createDatasetManifestV2,
  datasetLayoutIdentityV2FromManifest,
  ManifestIntegrityErrorV2,
  parseStoredDatasetManifestV2,
  V2_MANIFEST_MAX_BYTES,
} from '../src/index.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const datasetVersion = `01${'a'.repeat(62)}`
const artifactDigest = 'b'.repeat(64)

const layoutIdentity = {
  identity_profile: 'databench-v2-jcs-1',
  record_schema_version: '2.0.0',
  dataset_version: datasetVersion,
  num_records: 2,
  layout_version: 'record-json-v1',
  artifact_digest: artifactDigest,
  artifact_size_bytes: 123,
} as const

const expectedCanonical =
  `{"artifact_digest":"${artifactDigest}","artifact_size_bytes":123,` +
  `"columns":["record_id","record_digest","record_json"],` +
  `"dataset_version":"${datasetVersion}","hash_algorithm":"blake3",` +
  `"identity_profile":"databench-v2-jcs-1","layout_version":"record-json-v1",` +
  `"manifest_version":"2.0.0","num_records":2,"record_schema_version":"2.0.0"}`

describe('DatasetManifestV2 canonical bytes', () => {
  test('materializes fixed fields and emits the exact RFC 8785 bytes', () => {
    const manifest = createDatasetManifestV2(layoutIdentity)

    expect(manifest).toEqual({
      manifest_version: '2.0.0',
      identity_profile: 'databench-v2-jcs-1',
      dataset_version: datasetVersion,
      record_schema_version: '2.0.0',
      hash_algorithm: 'blake3',
      num_records: 2,
      layout_version: 'record-json-v1',
      artifact_digest: artifactDigest,
      artifact_size_bytes: 123,
      columns: ['record_id', 'record_digest', 'record_json'],
    })
    expect(textDecoder.decode(canonicalDatasetManifestV2Bytes(manifest))).toBe(expectedCanonical)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.columns)).toBe(true)
  })

  test('round-trips only exact canonical raw bytes', () => {
    const bytes = textEncoder.encode(expectedCanonical)
    const manifest = parseStoredDatasetManifestV2(bytes)

    expect(textDecoder.decode(canonicalDatasetManifestV2Bytes(manifest))).toBe(expectedCanonical)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.columns)).toBe(true)
  })

  test.each([
    ['malformed JSON', textEncoder.encode('{"manifest_version":')],
    [
      'duplicate keys',
      textEncoder.encode('{"manifest_version":"2.0.0","manifest_version":"2.0.0"}'),
    ],
    [
      'unknown fields',
      textEncoder.encode(
        canonicalJsonV2({
          ...createDatasetManifestV2(layoutIdentity),
          unexpected: true,
        }),
      ),
    ],
  ])('classifies stored %s as integrity failure', (_name, bytes) => {
    expectStoredManifestIntegrityFailure(bytes, 'malformed_manifest')
  })

  test.each([
    ['trailing newline', textEncoder.encode(`${expectedCanonical}\n`)],
    ['surrounding whitespace', textEncoder.encode(` ${expectedCanonical}`)],
    [
      'noncanonical property order',
      textEncoder.encode(JSON.stringify(createDatasetManifestV2(layoutIdentity))),
    ],
  ])('rejects semantically valid %s bytes', (_name, bytes) => {
    expectStoredManifestIntegrityFailure(bytes, 'noncanonical_manifest_bytes')
  })

  test('rejects stored bytes over the fixed manifest limit as integrity failure', () => {
    const oversized = new Uint8Array(V2_MANIFEST_MAX_BYTES + 1).fill(0x20)
    expectStoredManifestIntegrityFailure(oversized, 'malformed_manifest')
  })
})

describe('DatasetLayoutIdentityV2 projection', () => {
  test('projects exactly the snapshot and physical artifact identity', () => {
    const manifest = createDatasetManifestV2(layoutIdentity)
    const identity = datasetLayoutIdentityV2FromManifest(manifest)

    expect(identity).toEqual(layoutIdentity)
    expect(Object.keys(identity).sort()).toEqual(Object.keys(layoutIdentity).sort())
    expect(Object.isFrozen(identity)).toBe(true)
    expect(identity).not.toHaveProperty('manifest_version')
    expect(identity).not.toHaveProperty('hash_algorithm')
    expect(identity).not.toHaveProperty('columns')
  })

  test('does not accept unknown identity fields when creating a manifest', () => {
    expect(() =>
      createDatasetManifestV2({
        ...layoutIdentity,
        temporary_key: 'must-not-enter-canonical-manifest',
      }),
    ).toThrow()
  })
})

function expectStoredManifestIntegrityFailure(bytes: Uint8Array, reason: string): void {
  let error: unknown
  try {
    parseStoredDatasetManifestV2(bytes)
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(ManifestIntegrityErrorV2)
  expect(error).toMatchObject({
    code: 'integrity_error',
    detail: { reason },
  })
  expect(classifyError(error)).toBe('integrity_error')
}
