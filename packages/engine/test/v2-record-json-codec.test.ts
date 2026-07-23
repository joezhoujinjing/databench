import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, open, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import { hashArtifactBytes } from '@databench/hashing'
import type { PostTrainingRecordV2 } from '@databench/schema'
import {
  asyncBufferFromFile,
  type FileMetaData,
  parquetMetadataAsync,
  type SchemaElement,
} from 'hyparquet'
import { fileWriter, parquetWriteRows } from 'hyparquet-writer'
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js'
import { writeMetadata } from 'hyparquet-writer/src/metadata.js'
import { afterEach, describe, expect, test } from 'vitest'
import {
  decodeRecordJsonV1FromFileHandle,
  decodeRecordJsonV1FromPath,
  RECORD_JSON_V1_COLUMNS,
  RECORD_JSON_V1_DATA_PAGE_SIZE,
  RECORD_JSON_V1_ROW_GROUP_SIZE,
  RECORD_JSON_V1_ZSTD_LEVEL,
  RecordJsonV1IntegrityError,
  V2Dataset,
  writeRecordJsonV1ToFileHandle,
  writeRecordJsonV1ToPath,
} from '../src/index.js'

const fixture = JSON.parse(
  readFileSync(
    new URL('./golden/fixtures/v2/dataset-permutation-and-limits.fixture.json', import.meta.url),
    'utf8',
  ),
) as { records: PostTrainingRecordV2[] }

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('record-json-v1 writer', () => {
  test('writes the exact physical schema and hashes the completed file in a second pass', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records)

    const result = await writeRecordJsonV1ToPath(dataset, path)
    const bytes = readFileSync(path)
    const metadata = await parquetMetadataAsync(await asyncBufferFromFile(path))

    expect(result).toEqual({
      artifactDigest: hashArtifactBytes(bytes),
      artifactSizeBytes: bytes.byteLength,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(metadata.version).toBe(2)
    expect(metadata.created_by).toBe('hyparquet')
    expect(metadata.key_value_metadata).toEqual([])
    expect(metadata.schema).toEqual(PARQUET_SCHEMA)
    expect(metadata.row_groups).toHaveLength(1)
    expect(metadata.row_groups[0]?.num_rows).toBe(BigInt(fixture.records.length))
    for (const chunk of metadata.row_groups[0]?.columns ?? []) {
      expect(chunk.meta_data).toMatchObject({
        codec: 'ZSTD',
        encodings: ['PLAIN'],
      })
      expect(chunk.meta_data?.statistics).toBeUndefined()
      expect(chunk.offset_index_offset).toBeUndefined()
      expect(chunk.column_index_offset).toBeUndefined()
    }
  })

  test('writes a valid empty artifact and preserves byte stability across independent paths', async () => {
    const firstPath = await createStoreOwnedPath('first.parquet')
    const secondPath = await createStoreOwnedPath('second.parquet')
    const dataset = V2Dataset.fromRecords([])

    const [first, second] = await Promise.all([
      writeRecordJsonV1ToPath(dataset, firstPath),
      writeRecordJsonV1ToPath(dataset, secondPath),
    ])

    expect(first).toEqual(second)
    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath))
    const metadata = await parquetMetadataAsync(await asyncBufferFromFile(firstPath))
    expect(metadata.num_rows).toBe(0n)
    expect(metadata.row_groups).toEqual([])
    expect(metadata.schema).toEqual(PARQUET_SCHEMA)
  })

  test('requires an existing Store-owned regular file and honors a pre-aborted signal', async () => {
    const directory = await createTemporaryDirectory()
    const missing = join(directory, 'missing.parquet')
    const controller = new AbortController()
    controller.abort()

    await expect(writeRecordJsonV1ToPath(V2Dataset.fromRecords([]), missing)).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    )
    const existing = await createStoreOwnedPath()
    await expect(
      writeRecordJsonV1ToPath(V2Dataset.fromRecords([]), existing, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('keeps handle-based write, hash, and decode bound to the same file instance', async () => {
    const path = await createStoreOwnedPath()
    const retainedPath = join(await createTemporaryDirectory(), 'retained.parquet')
    const dataset = V2Dataset.fromRecords(fixture.records)
    const handle = await open(path, 'r+')
    try {
      const result = await writeRecordJsonV1ToFileHandle(dataset, handle)
      await rename(path, retainedPath)
      await writeFile(path, new Uint8Array())

      expect(result.artifactDigest).toBe(hashArtifactBytes(readFileSync(retainedPath)))
      expect(readFileSync(path)).toHaveLength(0)
      const decoded = await decodeRecordJsonV1FromFileHandle(handle, {
        expectedIdentity: dataset.identity,
      })
      expect(decoded.identity).toEqual(dataset.identity)
      await expect(handle.stat()).resolves.toMatchObject({ size: result.artifactSizeBytes })
    } finally {
      await handle.close()
    }
  })
})

describe('record-json-v1 decoder', () => {
  test('strictly round-trips canonical records and expected dataset identity', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records)
    await writeRecordJsonV1ToPath(dataset, path)

    const decoded = await decodeRecordJsonV1FromPath(path, {
      expectedIdentity: dataset.identity,
    })

    expect(decoded.identity).toEqual(dataset.identity)
    expect([...decoded.records()].map((revision) => revision.record_json)).toEqual(
      [...dataset.records()].map((revision) => revision.record_json),
    )
  })

  test('rejects expected count/version mismatches as typed integrity failures', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records)
    await writeRecordJsonV1ToPath(dataset, path)

    await expect(
      decodeRecordJsonV1FromPath(path, {
        expectedIdentity: { ...dataset.identity, num_records: dataset.length - 1 },
      }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'row_count_mismatch',
    })

    await expect(
      decodeRecordJsonV1FromPath(path, {
        expectedIdentity: { ...dataset.identity, num_records: dataset.length - 1 },
        limits: {
          max_records: dataset.length - 1,
          max_canonical_bytes: dataset.canonicalBytes,
          max_record_bytes: Math.max(
            ...[...dataset.records()].map((revision) =>
              Buffer.byteLength(revision.record_json, 'utf8'),
            ),
          ),
        },
      }),
    ).rejects.toMatchObject({ reason: 'row_count_mismatch' })

    await expect(
      decodeRecordJsonV1FromPath(path, {
        expectedIdentity: { ...dataset.identity, dataset_version: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({
      reason: 'dataset_identity_mismatch',
    })
  })

  test('rejects optional columns before rows are decoded', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records.slice(0, 1))
    await writeCustomArtifact(path, rowsFor(dataset), optionalSchema())

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({
      reason: 'schema_mismatch',
      detail: expect.objectContaining({ layout_version: 'record-json-v1' }),
    })

    const fieldIdPath = await createStoreOwnedPath('field-id.parquet')
    const fieldIdSchema = PARQUET_SCHEMA.map((element, index) =>
      index === 1 ? { ...element, field_id: 1 } : { ...element },
    )
    await writeCustomArtifact(fieldIdPath, rowsFor(dataset), fieldIdSchema)
    await expect(
      decodeRecordJsonV1FromPath(fieldIdPath, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({ reason: 'schema_mismatch' })
  })

  test('enforces canonical byte admission while decoding row groups', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records)
    await writeRecordJsonV1ToPath(dataset, path)

    await expect(
      decodeRecordJsonV1FromPath(path, {
        expectedIdentity: dataset.identity,
        limits: {
          max_records: dataset.length,
          max_canonical_bytes: dataset.canonicalBytes - 1,
          max_record_bytes: Math.max(
            ...[...dataset.records()].map((revision) =>
              Buffer.byteLength(revision.record_json, 'utf8'),
            ),
          ),
        },
      }),
    ).rejects.toMatchObject({
      code: 'resource_limit',
      detail: expect.objectContaining({ resource: 'canonical_bytes' }),
    })
  })

  test('maps malformed UTF-8 in a physical UTF8 column to typed integrity failure', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records.slice(0, 1))
    const [row] = rowsFor(dataset)
    await writeCustomArtifact(path, [
      {
        ...row,
        record_json: new Uint8Array([0xff, 0xfe, 0xfd]),
      },
    ])

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'parquet_unreadable',
    })
  })

  test('propagates cancellation during file-backed decode', async () => {
    const path = await createStoreOwnedPath()
    const [record] = fixture.records
    if (!record) throw new Error('fixture record is required')
    const dataset = V2Dataset.fromRecords([
      { ...record, extra: { payload: 'x'.repeat(4 * 1024 * 1024) } },
    ])
    await writeRecordJsonV1ToPath(dataset, path)
    const controller = new AbortController()

    const result = decodeRecordJsonV1FromPath(path, {
      expectedIdentity: dataset.identity,
      signal: controller.signal,
    })
    setImmediate(() => controller.abort())

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('rejects noncanonical JSON, column mismatches, and physical row reordering', async () => {
    const dataset = V2Dataset.fromRecords(fixture.records)
    const canonicalRows = rowsFor(dataset)

    const noncanonicalPath = await createStoreOwnedPath('noncanonical.parquet')
    const noncanonical = canonicalRows.map((row, index) =>
      index === 0 ? { ...row, record_json: ` ${row.record_json}` } : row,
    )
    await writeCustomArtifact(noncanonicalPath, noncanonical)
    await expect(
      decodeRecordJsonV1FromPath(noncanonicalPath, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({ reason: 'record_json_noncanonical' })

    const idPath = await createStoreOwnedPath('id.parquet')
    const wrongId = canonicalRows.map((row, index) =>
      index === 0 ? { ...row, record_id: `rec_${'f'.repeat(64)}` } : row,
    )
    await writeCustomArtifact(idPath, wrongId)
    await expect(
      decodeRecordJsonV1FromPath(idPath, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({ reason: 'record_id_mismatch' })

    const digestPath = await createStoreOwnedPath('digest.parquet')
    const wrongDigest = canonicalRows.map((row, index) =>
      index === 0 ? { ...row, record_digest: 'f'.repeat(64) } : row,
    )
    await writeCustomArtifact(digestPath, wrongDigest)
    await expect(
      decodeRecordJsonV1FromPath(digestPath, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({ reason: 'record_digest_mismatch' })

    const orderPath = await createStoreOwnedPath('order.parquet')
    await writeCustomArtifact(orderPath, [...canonicalRows].reverse())
    await expect(
      decodeRecordJsonV1FromPath(orderPath, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({ reason: 'row_order_mismatch' })
  })

  test('rejects unreadable Parquet and never exposes record JSON in error detail', async () => {
    const path = await createStoreOwnedPath()
    await writeFile(path, Buffer.from('not parquet'))
    const empty = V2Dataset.fromRecords([])

    let error: unknown
    try {
      await decodeRecordJsonV1FromPath(path, { expectedIdentity: empty.identity })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(RecordJsonV1IntegrityError)
    expect(error).toMatchObject({ reason: 'parquet_unreadable' })
    expect((error as RecordJsonV1IntegrityError).detail).not.toHaveProperty('record_json')
  })

  test('rejects oversized artifacts before attempting to parse Parquet metadata', async () => {
    const path = await createStoreOwnedPath()
    const empty = V2Dataset.fromRecords([])
    const limits = {
      max_records: 0,
      max_canonical_bytes: 0,
      max_record_bytes: 0,
    }
    await truncate(path, 64 * 1024 * 1024 + 1)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: empty.identity, limits }),
    ).rejects.toMatchObject({
      name: 'ResourceLimitError',
      code: 'resource_limit',
      detail: expect.objectContaining({ resource: 'artifact_size_bytes' }),
    })
  })

  test('rejects an impossible four-gibibyte footer length without allocating it', async () => {
    const path = await createStoreOwnedPath()
    const bytes = Buffer.alloc(12)
    bytes.write('PAR1', 0, 'ascii')
    bytes.writeUInt32LE(0xffff_ffff, 4)
    bytes.write('PAR1', 8, 'ascii')
    await writeFile(path, bytes)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: V2Dataset.fromRecords([]).identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'parquet_unreadable',
    })
  })

  test('rejects a tiny footer that declares an enormous Compact Thrift list', async () => {
    const path = await createStoreOwnedPath()
    const metadata = Buffer.from([0x29, 0xf3, 0xff, 0xff, 0xff, 0xff, 0x07, 0x00])
    const bytes = Buffer.alloc(4 + metadata.byteLength + 8)
    bytes.write('PAR1', 0, 'ascii')
    metadata.copy(bytes, 4)
    bytes.writeUInt32LE(metadata.byteLength, 4 + metadata.byteLength)
    bytes.write('PAR1', 8 + metadata.byteLength, 'ascii')
    await writeFile(path, bytes)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: V2Dataset.fromRecords([]).identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'parquet_unreadable',
    })
  })

  test('rejects a footer whose field count exceeds the expected row-group budget', async () => {
    const path = await createStoreOwnedPath()
    const metadata = Buffer.from([...new Uint8Array(65).fill(0x11), 0x00])
    const bytes = Buffer.alloc(4 + metadata.byteLength + 8)
    bytes.write('PAR1', 0, 'ascii')
    metadata.copy(bytes, 4)
    bytes.writeUInt32LE(metadata.byteLength, 4 + metadata.byteLength)
    bytes.write('PAR1', 8 + metadata.byteLength, 'ascii')
    await writeFile(path, bytes)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: V2Dataset.fromRecords([]).identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'parquet_unreadable',
    })
  })

  test('rejects a page header that declares an enormous Compact Thrift list', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records.slice(0, 1))
    await writeRecordJsonV1ToPath(dataset, path)
    const bytes = readFileSync(path)
    Buffer.from([0x19, 0xf3, 0xff, 0xff, 0xff, 0xff, 0x07]).copy(bytes, 4)
    await writeFile(path, bytes)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'parquet_unreadable',
    })
  })

  test('rejects overlapping column chunk ranges before row-group allocation', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records.slice(0, 1))
    await writeRecordJsonV1ToPath(dataset, path)
    const bytes = readFileSync(path)
    const metadata = await parquetMetadataAsync(await asyncBufferFromFile(path))
    const metadataOffset = bytes.byteLength - metadata.metadata_length - 8
    const [first, second] = metadata.row_groups[0]?.columns ?? []
    if (!first?.meta_data || !second?.meta_data) throw new Error('test column metadata is required')
    second.file_offset = first.file_offset
    second.meta_data.data_page_offset = first.meta_data.data_page_offset
    await rewriteFooter(path, bytes.subarray(0, metadataOffset), metadata)

    await expect(
      decodeRecordJsonV1FromPath(path, { expectedIdentity: dataset.identity }),
    ).rejects.toMatchObject({
      name: 'RecordJsonV1IntegrityError',
      code: 'integrity_error',
      reason: 'schema_mismatch',
    })
  })

  test('rejects a ZSTD frame that declares an oversized output before WASM allocation', async () => {
    const path = await createStoreOwnedPath()
    const dataset = V2Dataset.fromRecords(fixture.records.slice(0, 1))
    await writeCustomArtifact(path, rowsFor(dataset))
    const bytes = readFileSync(path)
    const frameOffset = bytes.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    expect(frameOffset).toBeGreaterThanOrEqual(0)
    bytes[frameOffset + 4] = 0xe0
    bytes.writeBigUInt64LE(32n * 1024n * 1024n, frameOffset + 5)
    await writeFile(path, bytes)

    await expect(
      decodeRecordJsonV1FromPath(path, {
        expectedIdentity: dataset.identity,
        limits: {
          max_records: dataset.length,
          max_canonical_bytes: dataset.canonicalBytes,
          max_record_bytes: dataset.canonicalBytes,
        },
      }),
    ).rejects.toMatchObject({
      name: 'ResourceLimitError',
      code: 'resource_limit',
      detail: expect.objectContaining({ resource: 'parquet_page_bytes' }),
    })
  })
})

const PARQUET_SCHEMA: SchemaElement[] = [
  { name: 'schema', num_children: 3 },
  ...RECORD_JSON_V1_COLUMNS.map((name) => ({
    name,
    type: 'BYTE_ARRAY' as const,
    converted_type: 'UTF8' as const,
    repetition_type: 'REQUIRED' as const,
  })),
]

function optionalSchema(): SchemaElement[] {
  return PARQUET_SCHEMA.map((element, index) =>
    index === 0 ? { ...element } : { ...element, repetition_type: 'OPTIONAL' },
  )
}

function rowsFor(dataset: V2Dataset) {
  return [...dataset.records()].map((revision) => ({
    record_id: revision.record.id,
    record_digest: revision.record_digest,
    record_json: revision.record_json,
  }))
}

async function writeCustomArtifact(
  path: string,
  rows: Array<{
    record_id: string
    record_digest: string
    record_json: string | Uint8Array
  }>,
  schema: SchemaElement[] = PARQUET_SCHEMA,
): Promise<void> {
  await parquetWriteRows({
    writer: fileWriter(path),
    rows,
    columns: RECORD_JSON_V1_COLUMNS.map((name) => ({
      name,
      encoding: 'PLAIN',
      columnIndex: false,
      offsetIndex: false,
    })),
    schema,
    codec: 'ZSTD',
    compressors: {
      ZSTD: (input) =>
        zstdCompressSync(input, {
          params: {
            [zlibConstants.ZSTD_c_compressionLevel]: RECORD_JSON_V1_ZSTD_LEVEL,
          },
        }),
    },
    statistics: false,
    rowGroupSize: RECORD_JSON_V1_ROW_GROUP_SIZE,
    pageSize: RECORD_JSON_V1_DATA_PAGE_SIZE,
    kvMetadata: [],
  })
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'databench-record-json-v1-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createStoreOwnedPath(name = 'artifact.parquet'): Promise<string> {
  const directory = await createTemporaryDirectory()
  const path = join(directory, name)
  await writeFile(path, new Uint8Array(), { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

async function rewriteFooter(
  path: string,
  parquetData: Uint8Array,
  metadata: FileMetaData,
): Promise<void> {
  const writer = new ByteWriter()
  writer.appendBytes(parquetData)
  writeMetadata(writer, metadata)
  writer.appendBytes(Buffer.from('PAR1'))
  await writeFile(path, writer.getBytes())
}
