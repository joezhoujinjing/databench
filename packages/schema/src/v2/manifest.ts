import {
  canonicalJsonV2,
  HASH_ALGO,
  V2_IDENTITY_PROFILE,
  V2_RECORD_SCHEMA_VERSION,
} from '@databench/hashing'
import { z } from 'zod'
import { IntegrityError } from '../errors.js'
import { DigestHexSchema, NonNegativeSafeIntegerSchema } from './common.js'
import { parseRawJsonV2 } from './raw-json.js'

export const V2_MANIFEST_VERSION = '2.0.0' as const
export const V2_MANIFEST_MAX_BYTES = 16 * 1024
export const V2_RECORD_JSON_LAYOUT_VERSION = 'record-json-v1' as const
export const V2_RECORD_JSON_COLUMNS = Object.freeze([
  'record_id',
  'record_digest',
  'record_json',
] as const)

export const DatasetLayoutIdentityV2Schema = z
  .object({
    identity_profile: z.literal(V2_IDENTITY_PROFILE),
    record_schema_version: z.literal(V2_RECORD_SCHEMA_VERSION),
    dataset_version: DigestHexSchema,
    num_records: NonNegativeSafeIntegerSchema,
    layout_version: z.literal(V2_RECORD_JSON_LAYOUT_VERSION),
    artifact_digest: DigestHexSchema,
    artifact_size_bytes: NonNegativeSafeIntegerSchema,
  })
  .strict()

export type DatasetLayoutIdentityV2 = z.infer<typeof DatasetLayoutIdentityV2Schema>

export const DatasetManifestV2Schema = z
  .object({
    manifest_version: z.literal(V2_MANIFEST_VERSION),
    identity_profile: z.literal(V2_IDENTITY_PROFILE),
    dataset_version: DigestHexSchema,
    record_schema_version: z.literal(V2_RECORD_SCHEMA_VERSION),
    hash_algorithm: z.literal(HASH_ALGO),
    num_records: NonNegativeSafeIntegerSchema,
    layout_version: z.literal(V2_RECORD_JSON_LAYOUT_VERSION),
    artifact_digest: DigestHexSchema,
    artifact_size_bytes: NonNegativeSafeIntegerSchema,
    columns: z.tuple([
      z.literal(V2_RECORD_JSON_COLUMNS[0]),
      z.literal(V2_RECORD_JSON_COLUMNS[1]),
      z.literal(V2_RECORD_JSON_COLUMNS[2]),
    ]),
  })
  .strict()
  .meta({ id: 'DatasetManifestV2' })

export type DatasetManifestV2 = z.infer<typeof DatasetManifestV2Schema>

export class ManifestIntegrityErrorV2 extends IntegrityError {
  override readonly name = 'ManifestIntegrityErrorV2'

  constructor(reason: string, cause?: unknown) {
    super('Stored V2 dataset manifest is invalid', { reason })
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
        writable: true,
      })
    }
  }
}

const textEncoder = new TextEncoder()

export function createDatasetManifestV2(input: unknown): Readonly<DatasetManifestV2> {
  const identity = DatasetLayoutIdentityV2Schema.parse(input)
  return freezeManifest(
    DatasetManifestV2Schema.parse({
      manifest_version: V2_MANIFEST_VERSION,
      identity_profile: identity.identity_profile,
      dataset_version: identity.dataset_version,
      record_schema_version: identity.record_schema_version,
      hash_algorithm: HASH_ALGO,
      num_records: identity.num_records,
      layout_version: identity.layout_version,
      artifact_digest: identity.artifact_digest,
      artifact_size_bytes: identity.artifact_size_bytes,
      columns: V2_RECORD_JSON_COLUMNS,
    }),
  )
}

export function canonicalDatasetManifestV2Bytes(input: unknown): Uint8Array {
  const manifest = freezeManifest(DatasetManifestV2Schema.parse(input))
  const bytes = textEncoder.encode(canonicalJsonV2(manifest))
  if (bytes.byteLength > V2_MANIFEST_MAX_BYTES) {
    throw new TypeError(`V2 dataset manifest exceeds ${V2_MANIFEST_MAX_BYTES} bytes`)
  }
  return bytes
}

export function parseStoredDatasetManifestV2(bytes: Uint8Array): Readonly<DatasetManifestV2> {
  try {
    const value = parseRawJsonV2(bytes, { maxBytes: V2_MANIFEST_MAX_BYTES, maxDepth: 16 })
    const manifest = freezeManifest(DatasetManifestV2Schema.parse(value))
    const canonical = canonicalDatasetManifestV2Bytes(manifest)
    if (!equalBytes(bytes, canonical)) {
      throw new ManifestIntegrityErrorV2('noncanonical_manifest_bytes')
    }
    return manifest
  } catch (error) {
    if (error instanceof ManifestIntegrityErrorV2) throw error
    throw new ManifestIntegrityErrorV2('malformed_manifest', error)
  }
}

export function datasetLayoutIdentityV2FromManifest(
  input: unknown,
): Readonly<DatasetLayoutIdentityV2> {
  const manifest = DatasetManifestV2Schema.parse(input)
  return Object.freeze({
    identity_profile: manifest.identity_profile,
    record_schema_version: manifest.record_schema_version,
    dataset_version: manifest.dataset_version,
    num_records: manifest.num_records,
    layout_version: manifest.layout_version,
    artifact_digest: manifest.artifact_digest,
    artifact_size_bytes: manifest.artifact_size_bytes,
  })
}

function freezeManifest(manifest: DatasetManifestV2): Readonly<DatasetManifestV2> {
  const columns = Object.freeze([...manifest.columns]) as DatasetManifestV2['columns']
  return Object.freeze({ ...manifest, columns })
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
