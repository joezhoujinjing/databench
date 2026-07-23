import { type BigIntStats, constants, writeSync } from 'node:fs'
import { type FileHandle, open, stat } from 'node:fs/promises'
import {
  compress as compressZstd,
  decompress as decompressZstd,
  init as initializeZstd,
} from '@bokuweb/zstd-wasm'
import {
  hashV2DatasetIdentity,
  V2_IDENTITY_PROFILE,
  V2_RECORD_SCHEMA_VERSION,
} from '@databench/hashing'
import {
  createRecordRevisionV2,
  DigestHexV2Schema,
  type PostTrainingRecordV2,
  parseRawJsonV2,
  type RawJsonLimitsV2,
  RecordIdV2Schema,
  ResourceLimitError,
  V2_RECORD_JSON_COLUMNS,
  V2_RECORD_JSON_LAYOUT_VERSION,
} from '@databench/schema'
import {
  type AsyncBuffer,
  type FileMetaData,
  type ParquetParsers,
  parquetMetadataAsync,
  parquetReadObjects,
  type RowGroup,
  type SchemaElement,
} from 'hyparquet'
import { ByteWriter, type ColumnSource, parquetWriteRows, type Writer } from 'hyparquet-writer'
import { hashV2ArtifactFileHandle, type V2ArtifactFileDigest } from './artifact-file.js'
import { type CompactThriftField, preflightCompactThrift } from './compact-thrift-preflight.js'
import {
  type DatasetSnapshotIdentityV2,
  DEFAULT_V2_DATASET_LIMITS,
  V2Dataset,
  type V2DatasetLimits,
} from './dataset.js'
import {
  assertV2RecordIdentityAvailable,
  DuplicateRecordIdErrorV2,
  RecordDigestCollisionErrorV2,
} from './dataset-invariants.js'
import {
  type RecordJsonV1IntegrityDetail,
  RecordJsonV1IntegrityError,
  type RecordJsonV1IntegrityReason,
} from './record-json-errors.js'

export const RECORD_JSON_V1_LAYOUT_VERSION = V2_RECORD_JSON_LAYOUT_VERSION
export const RECORD_JSON_V1_COLUMNS = V2_RECORD_JSON_COLUMNS

export const RECORD_JSON_V1_ROW_GROUP_SIZE = 65_536
export const RECORD_JSON_V1_DATA_PAGE_SIZE = 1024 * 1024
export const RECORD_JSON_V1_ZSTD_LEVEL = 3

const RECORD_JSON_V1_MAX_FOOTER_SIZE = 1024 * 1024
const RECORD_JSON_V1_MAX_FOOTER_COLLECTION_ELEMENTS = 128 * 1024
const RECORD_JSON_V1_MAX_PAGE_HEADER_SIZE = 4 * 1024
const RECORD_JSON_V1_ARTIFACT_OVERHEAD_BYTES = 64 * 1024 * 1024
const RECORD_JSON_V1_ROW_PHYSICAL_OVERHEAD_BYTES = 256
const PARQUET_MAGIC = Buffer.from('PAR1')
const THRIFT_I32 = 5
const THRIFT_STRUCT = 12

export type RecordJsonV1WriteResult = V2ArtifactFileDigest

export interface RecordJsonV1CodecOptions {
  readonly signal?: AbortSignal
}

export interface DecodeRecordJsonV1Options extends RecordJsonV1CodecOptions {
  readonly expectedIdentity: DatasetSnapshotIdentityV2
  readonly limits?: V2DatasetLimits
}

interface RecordJsonV1Row {
  readonly record_id: string
  readonly record_digest: string
  readonly record_json: string
}

interface ValidatedDecodeOptions {
  readonly expectedIdentity: Readonly<DatasetSnapshotIdentityV2>
  readonly limits: Readonly<V2DatasetLimits>
  readonly signal?: AbortSignal
}

interface DecodeAccumulator {
  readonly records: Array<PostTrainingRecordV2 | undefined>
  readonly recordIds: Set<string>
  readonly canonicalByDigest: Map<string, string>
  previous: RecordJsonV1Row | undefined
  canonicalBytes: number
}

interface HandleAsyncBuffer extends AsyncBuffer {
  readonly metadataOffset: number
  readonly snapshot: BigIntStats
}

const PARQUET_ROOT_NAME = 'schema'
const textEncoder = new TextEncoder()
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })
let zstdInitialization: Promise<void> | undefined

const PARQUET_SCHEMA: readonly SchemaElement[] = Object.freeze([
  Object.freeze({ name: PARQUET_ROOT_NAME, num_children: RECORD_JSON_V1_COLUMNS.length }),
  ...RECORD_JSON_V1_COLUMNS.map((name) =>
    Object.freeze({
      name,
      type: 'BYTE_ARRAY' as const,
      converted_type: 'UTF8' as const,
      repetition_type: 'REQUIRED' as const,
    }),
  ),
])

const PARQUET_COLUMNS: Omit<ColumnSource, 'data'>[] = RECORD_JSON_V1_COLUMNS.map((name) => ({
  name,
  encoding: 'PLAIN',
  columnIndex: false,
  offsetIndex: false,
}))

// Hyparquet merges parser overrides with its complete defaults at runtime. Its
// public type currently requires the full parser map, so this isolated cast
// supplies only the behavior this layout must tighten: malformed UTF-8 fails.
const STRICT_UTF8_PARSERS = {
  stringFromBytes(bytes: Uint8Array): string {
    return fatalUtf8Decoder.decode(bytes)
  },
} as ParquetParsers

export async function writeRecordJsonV1ToPath(
  dataset: V2Dataset,
  outputPath: string,
  options: RecordJsonV1CodecOptions = {},
): Promise<Readonly<RecordJsonV1WriteResult>> {
  validateOutputPath(outputPath)
  const handle = await open(outputPath, constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    const result = await writeRecordJsonV1ToFileHandle(dataset, handle, options)
    await assertPathStillReferencesHandle(outputPath, handle)
    return result
  } finally {
    await handle.close()
  }
}

export async function writeRecordJsonV1ToFileHandle(
  dataset: V2Dataset,
  handle: FileHandle,
  options: RecordJsonV1CodecOptions = {},
): Promise<Readonly<RecordJsonV1WriteResult>> {
  if (!(dataset instanceof V2Dataset)) {
    throw new TypeError('record-json-v1 writer requires a V2Dataset')
  }
  validateFileHandle(handle)
  validateAbortSignal(options.signal)
  const initialStat = await handle.stat({ bigint: true })
  if (!initialStat.isFile()) {
    throw new TypeError('record-json-v1 output handle must reference a regular file')
  }

  options.signal?.throwIfAborted()
  validateDatasetForEncoding(dataset)
  await ensureZstdInitialized()
  options.signal?.throwIfAborted()
  await handle.truncate(0)

  const rows = recordRows(dataset, options.signal)
  await parquetWriteRows({
    writer: fileHandleWriter(handle),
    rows,
    columns: PARQUET_COLUMNS,
    schema: [...PARQUET_SCHEMA],
    codec: 'ZSTD',
    compressors: { ZSTD: compressRecordJsonPage },
    statistics: false,
    rowGroupSize: RECORD_JSON_V1_ROW_GROUP_SIZE,
    pageSize: RECORD_JSON_V1_DATA_PAGE_SIZE,
    kvMetadata: [],
  })

  options.signal?.throwIfAborted()
  await handle.sync()
  return await hashV2ArtifactFileHandle(handle, options.signal)
}

export async function decodeRecordJsonV1FromPath(
  inputPath: string,
  options: DecodeRecordJsonV1Options,
): Promise<V2Dataset> {
  validateInputPath(inputPath)
  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await decodeRecordJsonV1FromFileHandle(handle, options)
  } finally {
    await handle.close()
  }
}

export async function decodeRecordJsonV1FromFileHandle(
  handle: FileHandle,
  options: DecodeRecordJsonV1Options,
): Promise<V2Dataset> {
  validateFileHandle(handle)
  const validated = validateDecodeOptions(options)
  validated.signal?.throwIfAborted()
  await ensureZstdInitialized()
  validated.signal?.throwIfAborted()

  const file = await asyncBufferFromHandle(
    handle,
    validated.limits,
    validated.expectedIdentity.num_records,
    validated.signal,
  )
  let metadata: FileMetaData
  try {
    metadata = await parquetMetadataAsync(file, { geoparquet: false })
  } catch (error) {
    rethrowFileIoOrAbort(error)
    throw integrity('parquet_unreadable', 'record-json-v1 Parquet metadata is unreadable')
  }

  validatePhysicalLayout(metadata)
  if (metadata.num_rows !== BigInt(validated.expectedIdentity.num_records)) {
    throw integrity('row_count_mismatch', 'Parquet row count does not match dataset identity', {
      expected: validated.expectedIdentity.num_records,
      actual: metadata.num_rows.toString(),
    })
  }
  const metadataCount = admitMetadataCount(metadata.num_rows, validated.limits.max_records)
  admitPhysicalDecodeSize(metadata, validated.limits)
  await preflightPhysicalPages(file, metadata, validated.limits, validated.signal)

  const records = await decodeRowGroups(file, metadata, metadataCount, validated)
  let dataset: V2Dataset
  try {
    dataset = V2Dataset.fromRecords(consumeRecords(records), validated.limits)
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      throw error
    }
    throw integrity('dataset_identity_mismatch', 'Decoded records cannot form the declared dataset')
  }
  validated.signal?.throwIfAborted()
  assertExpectedDatasetIdentity(dataset, validated.expectedIdentity)
  await assertHandleSnapshotUnchanged(handle, file.snapshot)
  return dataset
}

function validateDatasetForEncoding(dataset: V2Dataset): void {
  const recordIds = new Set<string>()
  const canonicalByDigest = new Map<string, string>()
  const recordDigests: string[] = []
  let previous: RecordJsonV1Row | undefined
  let count = 0

  for (const revision of dataset.records()) {
    let recomputed: ReturnType<typeof createRecordRevisionV2>
    try {
      recomputed = createRecordRevisionV2(revision.record)
    } catch {
      throw integrity(
        'record_json_invalid',
        'V2Dataset contains a record that is not strict canonical v2',
        { row_index: count },
      )
    }

    if (revision.record_json !== recomputed.record_json) {
      throw integrity(
        'record_json_noncanonical',
        'V2Dataset record JSON does not match its canonical record',
        { row_index: count, column: 'record_json' },
      )
    }
    if (revision.record.id !== recomputed.record.id) {
      throw integrity('record_id_mismatch', 'V2Dataset record ID is inconsistent', {
        row_index: count,
        column: 'record_id',
      })
    }
    if (revision.record_digest !== recomputed.record_digest) {
      throw integrity('record_digest_mismatch', 'V2Dataset record digest is inconsistent', {
        row_index: count,
        column: 'record_digest',
      })
    }

    const row = rowFromRevision(recomputed)
    assertPhysicalOrder(previous, row, count)
    try {
      assertV2RecordIdentityAvailable(row, recordIds, canonicalByDigest, count)
    } catch (error) {
      rethrowIdentityIntegrity(error, count)
    }

    recordIds.add(row.record_id)
    canonicalByDigest.set(row.record_digest, row.record_json)
    recordDigests.push(row.record_digest)
    previous = row
    count += 1
  }

  const version = hashV2DatasetIdentity({
    identity_profile: V2_IDENTITY_PROFILE,
    record_schema_version: V2_RECORD_SCHEMA_VERSION,
    record_digests: recordDigests,
  })
  const identity = dataset.identity
  if (
    identity.identity_profile !== V2_IDENTITY_PROFILE ||
    identity.record_schema_version !== V2_RECORD_SCHEMA_VERSION ||
    identity.num_records !== count ||
    identity.dataset_version !== version
  ) {
    throw integrity(
      'dataset_identity_mismatch',
      'V2Dataset identity does not match its canonical records',
    )
  }
}

function* recordRows(dataset: V2Dataset, signal?: AbortSignal): Iterable<RecordJsonV1Row> {
  for (const revision of dataset.records()) {
    signal?.throwIfAborted()
    yield rowFromRevision(revision)
  }
}

function fileHandleWriter(handle: FileHandle): Writer {
  const writer = new ByteWriter()
  const chunkSize = 1_000_000
  let fileOffset = 0

  function flush(): void {
    const chunk = new Uint8Array(writer.buffer, 0, writer.index)
    let chunkOffset = 0
    while (chunkOffset < chunk.byteLength) {
      const written = writeSync(
        handle.fd,
        chunk,
        chunkOffset,
        chunk.byteLength - chunkOffset,
        fileOffset + chunkOffset,
      )
      if (written === 0) throw new Error('Unable to make progress writing Parquet artifact')
      chunkOffset += written
    }
    fileOffset += chunk.byteLength
    writer.index = 0
  }

  writer.ensure = (size: number): void => {
    if (writer.index > chunkSize) flush()
    if (writer.index + size > writer.buffer.byteLength) {
      const newSize = Math.max(writer.buffer.byteLength * 2, writer.index + size)
      const newBuffer = new ArrayBuffer(newSize)
      new Uint8Array(newBuffer).set(new Uint8Array(writer.buffer))
      writer.buffer = newBuffer
      writer.view = new DataView(writer.buffer)
    }
  }
  writer.getBuffer = (): never => {
    throw new Error('getBuffer not supported for file-handle writer')
  }
  writer.getBytes = (): never => {
    throw new Error('getBytes not supported for file-handle writer')
  }
  writer.finish = flush
  return writer
}

function rowFromRevision(revision: {
  readonly record: { readonly id: string }
  readonly record_digest: string
  readonly record_json: string
}): RecordJsonV1Row {
  return Object.freeze({
    record_id: revision.record.id,
    record_digest: revision.record_digest,
    record_json: revision.record_json,
  })
}

async function decodeRowGroups(
  file: AsyncBuffer,
  metadata: FileMetaData,
  metadataCount: number,
  options: ValidatedDecodeOptions,
): Promise<Array<PostTrainingRecordV2 | undefined>> {
  const accumulator: DecodeAccumulator = {
    records: [],
    recordIds: new Set<string>(),
    canonicalByDigest: new Map<string, string>(),
    previous: undefined,
    canonicalBytes: 0,
  }
  let rowStart = 0

  for (const group of metadata.row_groups) {
    options.signal?.throwIfAborted()
    const rowEnd = rowStart + Number(group.num_rows)
    let rows: Record<string, unknown>[]
    try {
      rows = await parquetReadObjects({
        file,
        metadata,
        columns: [...RECORD_JSON_V1_COLUMNS],
        compressors: { ZSTD: createBoundedZstdDecompressor(options.limits) },
        parsers: STRICT_UTF8_PARSERS,
        geoparquet: false,
        utf8: false,
        rowStart,
        rowEnd,
      })
    } catch (error) {
      rethrowFileIoOrAbort(error)
      throw integrity('parquet_unreadable', 'record-json-v1 Parquet rows are unreadable')
    }
    options.signal?.throwIfAborted()

    if (rows.length !== rowEnd - rowStart) {
      throw integrity('row_count_mismatch', 'Decoded row group does not match Parquet metadata', {
        expected: rowEnd - rowStart,
        actual: rows.length,
      })
    }
    decodeRows(rows, rowStart, options.limits, accumulator, options.signal)
    rowStart = rowEnd
  }

  if (rowStart !== metadataCount || accumulator.records.length !== metadataCount) {
    throw integrity('row_count_mismatch', 'Decoded row count does not match Parquet metadata', {
      expected: metadataCount,
      actual: accumulator.records.length,
    })
  }
  return accumulator.records
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  firstRowIndex: number,
  limits: Readonly<V2DatasetLimits>,
  accumulator: DecodeAccumulator,
  signal?: AbortSignal,
): void {
  const { records, recordIds, canonicalByDigest } = accumulator

  rows.forEach((row, groupRowIndex) => {
    signal?.throwIfAborted()
    const rowIndex = firstRowIndex + groupRowIndex
    const recordId = requireStringColumn(row, 'record_id', rowIndex)
    const recordDigest = requireStringColumn(row, 'record_digest', rowIndex)
    const recordJson = requireStringColumn(row, 'record_json', rowIndex)

    if (!RecordIdV2Schema.safeParse(recordId).success) {
      throw integrity('record_id_mismatch', 'Parquet record_id has an invalid format', {
        row_index: rowIndex,
        column: 'record_id',
      })
    }
    if (!DigestHexV2Schema.safeParse(recordDigest).success) {
      throw integrity('record_digest_mismatch', 'Parquet record_digest has an invalid format', {
        row_index: rowIndex,
        column: 'record_digest',
      })
    }

    const rowView = { record_id: recordId, record_digest: recordDigest, record_json: recordJson }
    assertPhysicalOrder(accumulator.previous, rowView, rowIndex)

    const recordBytes = textEncoder.encode(recordJson)
    if (recordBytes.byteLength > limits.max_record_bytes) {
      throw new ResourceLimitError('Parquet record JSON exceeds the record byte limit', {
        resource: 'record_bytes',
        limit: limits.max_record_bytes,
        actual: recordBytes.byteLength,
      })
    }
    accumulator.canonicalBytes = checkedAddCanonicalBytes(
      accumulator.canonicalBytes,
      recordBytes.byteLength,
      limits.max_canonical_bytes,
    )

    let parsed: unknown
    try {
      const rawLimits: RawJsonLimitsV2 = {
        maxBytes: limits.max_record_bytes,
        maxDepth: 128,
      }
      parsed = parseRawJsonV2(recordBytes, rawLimits)
    } catch {
      throw integrity('record_json_invalid', 'Parquet record_json is not strict raw JSON', {
        row_index: rowIndex,
        column: 'record_json',
      })
    }

    let revision: ReturnType<typeof createRecordRevisionV2>
    try {
      revision = createRecordRevisionV2(parsed)
    } catch {
      throw integrity('record_json_invalid', 'Parquet record_json is not a strict v2 record', {
        row_index: rowIndex,
        column: 'record_json',
      })
    }
    if (revision.record_json !== recordJson) {
      throw integrity('record_json_noncanonical', 'Parquet record_json is not canonical JCS', {
        row_index: rowIndex,
        column: 'record_json',
      })
    }
    if (revision.record.id !== recordId) {
      throw integrity('record_id_mismatch', 'Parquet record_id does not match record_json', {
        row_index: rowIndex,
        column: 'record_id',
      })
    }
    if (revision.record_digest !== recordDigest) {
      throw integrity(
        'record_digest_mismatch',
        'Parquet record_digest does not match record_json',
        { row_index: rowIndex, column: 'record_digest' },
      )
    }

    try {
      assertV2RecordIdentityAvailable(rowView, recordIds, canonicalByDigest, rowIndex)
    } catch (error) {
      rethrowIdentityIntegrity(error, rowIndex)
    }
    recordIds.add(recordId)
    canonicalByDigest.set(recordDigest, recordJson)
    records.push(revision.record as PostTrainingRecordV2)
    accumulator.previous = rowView
  })
}

function validatePhysicalLayout(metadata: FileMetaData): void {
  if (
    !hasExactOwnKeys(metadata, [
      'created_by',
      'key_value_metadata',
      'metadata_length',
      'num_rows',
      'row_groups',
      'schema',
      'version',
    ]) ||
    metadata.version !== 2 ||
    metadata.created_by !== 'hyparquet' ||
    metadata.key_value_metadata?.length !== 0
  ) {
    throw integrity('schema_mismatch', 'Parquet writer metadata does not match record-json-v1')
  }

  const schema = metadata.schema
  const root = schema[0]
  if (
    schema.length !== PARQUET_SCHEMA.length ||
    root?.name !== PARQUET_ROOT_NAME ||
    root.num_children !== RECORD_JSON_V1_COLUMNS.length ||
    root.type !== undefined ||
    root.type_length !== undefined ||
    root.repetition_type !== undefined ||
    root.converted_type !== undefined ||
    root.scale !== undefined ||
    root.precision !== undefined ||
    root.field_id !== undefined ||
    root.logical_type !== undefined
  ) {
    throw integrity('schema_mismatch', 'Parquet schema root does not match record-json-v1')
  }

  RECORD_JSON_V1_COLUMNS.forEach((column, index) => {
    const element = schema[index + 1]
    if (!isExactRecordJsonColumn(element, column)) {
      throw integrity('schema_mismatch', 'Parquet column schema does not match record-json-v1', {
        column,
      })
    }
  })

  let totalRows = 0n
  metadata.row_groups.forEach((group, groupIndex) => {
    const isLast = groupIndex === metadata.row_groups.length - 1
    const rowCount = group.num_rows
    if (
      rowCount <= 0n ||
      rowCount > BigInt(RECORD_JSON_V1_ROW_GROUP_SIZE) ||
      (!isLast && rowCount !== BigInt(RECORD_JSON_V1_ROW_GROUP_SIZE))
    ) {
      throw integrity('schema_mismatch', 'Parquet row-group boundaries do not match record-json-v1')
    }
    validateRowGroup(group)
    totalRows += rowCount
  })

  if (
    totalRows !== metadata.num_rows ||
    (metadata.num_rows === 0n) !== (metadata.row_groups.length === 0)
  ) {
    throw integrity('row_count_mismatch', 'Parquet row groups do not match the footer row count')
  }
}

function isExactRecordJsonColumn(
  element: SchemaElement | undefined,
  name: (typeof RECORD_JSON_V1_COLUMNS)[number],
): boolean {
  return (
    element?.name === name &&
    element.type === 'BYTE_ARRAY' &&
    element.converted_type === 'UTF8' &&
    element.repetition_type === 'REQUIRED' &&
    element.num_children === undefined &&
    element.logical_type === undefined &&
    element.type_length === undefined &&
    element.scale === undefined &&
    element.precision === undefined &&
    element.field_id === undefined
  )
}

function validateRowGroup(group: RowGroup): void {
  if (
    group.columns.length !== RECORD_JSON_V1_COLUMNS.length ||
    group.sorting_columns !== undefined ||
    group.file_offset !== undefined ||
    group.total_compressed_size !== undefined ||
    group.ordinal !== undefined
  ) {
    throw integrity('schema_mismatch', 'Parquet row group has an unexpected column count')
  }
  let totalUncompressedSize = 0n
  RECORD_JSON_V1_COLUMNS.forEach((column, index) => {
    const chunk = group.columns[index]
    const meta = chunk?.meta_data
    if (
      !chunk ||
      !meta ||
      meta.type !== 'BYTE_ARRAY' ||
      meta.codec !== 'ZSTD' ||
      meta.encodings.length !== 1 ||
      meta.encodings[0] !== 'PLAIN' ||
      meta.path_in_schema.length !== 1 ||
      meta.path_in_schema[0] !== column ||
      meta.num_values !== group.num_rows ||
      meta.statistics !== undefined ||
      meta.encoding_stats !== undefined ||
      meta.dictionary_page_offset !== undefined ||
      meta.index_page_offset !== undefined ||
      meta.key_value_metadata !== undefined ||
      meta.bloom_filter_offset !== undefined ||
      meta.bloom_filter_length !== undefined ||
      meta.size_statistics !== undefined ||
      meta.geospatial_statistics !== undefined ||
      chunk.file_path !== undefined ||
      chunk.crypto_metadata !== undefined ||
      chunk.encrypted_column_metadata !== undefined ||
      chunk.offset_index_offset !== undefined ||
      chunk.offset_index_length !== undefined ||
      chunk.column_index_offset !== undefined ||
      chunk.column_index_length !== undefined
    ) {
      throw integrity('schema_mismatch', 'Parquet column chunk does not match record-json-v1', {
        column,
      })
    }
    if (
      meta.total_uncompressed_size < 0n ||
      meta.total_compressed_size < 0n ||
      chunk.file_offset !== meta.data_page_offset
    ) {
      throw integrity('schema_mismatch', 'Parquet column sizes or offsets are invalid', { column })
    }
    totalUncompressedSize += meta.total_uncompressed_size
  })
  if (group.total_byte_size !== totalUncompressedSize) {
    throw integrity('schema_mismatch', 'Parquet row-group byte size is inconsistent')
  }
}

function admitPhysicalDecodeSize(metadata: FileMetaData, limits: Readonly<V2DatasetLimits>): void {
  let recordJsonPhysicalBytes = 0n
  for (const group of metadata.row_groups) {
    const metadataForColumn = group.columns[2]?.meta_data
    if (!metadataForColumn) {
      throw integrity('schema_mismatch', 'Parquet record_json metadata is missing')
    }
    recordJsonPhysicalBytes += metadataForColumn.total_uncompressed_size
  }

  const maximumPhysicalBytes =
    BigInt(limits.max_canonical_bytes) +
    metadata.num_rows * 4n +
    BigInt(metadata.row_groups.length) * BigInt(RECORD_JSON_V1_DATA_PAGE_SIZE)
  if (recordJsonPhysicalBytes > maximumPhysicalBytes) {
    throw new ResourceLimitError('Parquet record JSON exceeds the canonical byte limit', {
      resource: 'canonical_bytes',
      limit: limits.max_canonical_bytes,
      actual: recordJsonPhysicalBytes.toString(),
    })
  }
}

async function preflightPhysicalPages(
  file: HandleAsyncBuffer,
  metadata: FileMetaData,
  limits: Readonly<V2DatasetLimits>,
  signal?: AbortSignal,
): Promise<void> {
  let expectedOffset = 4n
  let recordJsonUncompressedBytes = 0n

  for (const group of metadata.row_groups) {
    const groupRows = Number(group.num_rows)
    for (let columnIndex = 0; columnIndex < RECORD_JSON_V1_COLUMNS.length; columnIndex += 1) {
      signal?.throwIfAborted()
      const column = RECORD_JSON_V1_COLUMNS[columnIndex]
      const chunk = group.columns[columnIndex]
      const columnMetadata = chunk?.meta_data
      if (!columnMetadata || !column) {
        throw integrity('schema_mismatch', 'Parquet column metadata is missing')
      }
      const start = columnMetadata.data_page_offset
      const size = columnMetadata.total_compressed_size
      const end = start + size
      if (
        start !== expectedOffset ||
        size <= 0n ||
        end <= start ||
        end > BigInt(file.metadataOffset) ||
        end > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw integrity(
          'schema_mismatch',
          'Parquet column chunks are not exact contiguous artifact ranges',
          { column },
        )
      }

      const uncompressedBytes = await preflightColumnPages(
        file,
        Number(start),
        Number(end),
        groupRows,
        column,
        limits,
        signal,
      )
      if (column === 'record_id') {
        if (uncompressedBytes !== BigInt(groupRows) * 72n) {
          throw integrity('schema_mismatch', 'Parquet record_id pages have an invalid size')
        }
      } else if (column === 'record_digest') {
        if (uncompressedBytes !== BigInt(groupRows) * 68n) {
          throw integrity('schema_mismatch', 'Parquet record_digest pages have an invalid size')
        }
      } else {
        recordJsonUncompressedBytes += uncompressedBytes
      }
      expectedOffset = end
    }
  }

  if (expectedOffset !== BigInt(file.metadataOffset)) {
    throw integrity('schema_mismatch', 'Parquet data ranges do not end at the footer')
  }
  const recordJsonLimit =
    BigInt(limits.max_canonical_bytes) + metadata.num_rows * BigInt(Uint32Array.BYTES_PER_ELEMENT)
  if (recordJsonUncompressedBytes > recordJsonLimit) {
    throw new ResourceLimitError('Parquet record JSON pages exceed the canonical byte limit', {
      resource: 'canonical_bytes',
      limit: limits.max_canonical_bytes,
      actual: recordJsonUncompressedBytes.toString(),
    })
  }
}

async function preflightColumnPages(
  file: AsyncBuffer,
  start: number,
  end: number,
  expectedRows: number,
  column: (typeof RECORD_JSON_V1_COLUMNS)[number],
  limits: Readonly<V2DatasetLimits>,
  signal?: AbortSignal,
): Promise<bigint> {
  let offset = start
  let rows = 0
  let pages = 0
  let uncompressedBytes = 0n
  while (offset < end) {
    signal?.throwIfAborted()
    if (pages >= expectedRows) {
      throw integrity('schema_mismatch', 'Parquet column has too many data pages', { column })
    }
    const headerEnd = Math.min(end, offset + RECORD_JSON_V1_MAX_PAGE_HEADER_SIZE)
    const headerBuffer = await file.slice(offset, headerEnd)
    let scan: ReturnType<typeof preflightCompactThrift>
    try {
      scan = preflightCompactThrift(new Uint8Array(headerBuffer), {
        maxDepth: 8,
        maxCollectionLength: 0,
        maxTotalCollectionElements: 0,
        maxBinaryLength: 0,
        maxTotalFields: 10,
        maxTotalStructs: 2,
        captureFields: true,
      })
      validatePageHeaderFields(scan.fields)
    } catch {
      throw integrity('parquet_unreadable', 'Parquet page header exceeds its structural budget', {
        column,
      })
    }

    const pageType = requireCompactInteger(scan.fields, '1')
    const uncompressedSize = requireCompactInteger(scan.fields, '2')
    const compressedSize = requireCompactInteger(scan.fields, '3')
    const numValues = requireCompactInteger(scan.fields, '8.1')
    const numNulls = requireCompactInteger(scan.fields, '8.2')
    const numRows = requireCompactInteger(scan.fields, '8.3')
    const encoding = requireCompactInteger(scan.fields, '8.4')
    const definitionLevelBytes = requireCompactInteger(scan.fields, '8.5')
    const repetitionLevelBytes = requireCompactInteger(scan.fields, '8.6')
    if (
      pageType !== 3 ||
      uncompressedSize <= 0 ||
      compressedSize <= 0 ||
      numRows <= 0 ||
      numValues !== numRows ||
      numNulls !== 0 ||
      encoding !== 0 ||
      definitionLevelBytes !== 0 ||
      repetitionLevelBytes !== 0 ||
      numRows > expectedRows - rows
    ) {
      throw integrity('schema_mismatch', 'Parquet data page does not match record-json-v1', {
        column,
      })
    }
    const pageLimit = pageUncompressedLimit(column, expectedRows, limits)
    const pageEnd = offset + scan.byteLength + compressedSize
    if (pageEnd > end) {
      throw integrity('schema_mismatch', 'Parquet page exceeds its declared column chunk', {
        column,
      })
    }
    if (compressedSize > zstdCompressBound(uncompressedSize)) {
      throw integrity(
        'schema_mismatch',
        'Parquet page cannot be produced by the locked ZSTD writer',
        {
          column,
        },
      )
    }
    if (uncompressedSize > pageLimit) {
      throw new ResourceLimitError('Parquet data page exceeds its physical byte budget', {
        resource: 'parquet_page_bytes',
        limit: pageLimit,
        actual: uncompressedSize,
      })
    }
    rows += numRows
    pages += 1
    uncompressedBytes += BigInt(uncompressedSize)
    offset = pageEnd
  }

  if (offset !== end || rows !== expectedRows) {
    throw integrity('row_count_mismatch', 'Parquet page rows do not match the row group', {
      column,
      expected: expectedRows,
      actual: rows,
    })
  }
  return uncompressedBytes
}

function validatePageHeaderFields(fields: ReadonlyMap<string, Readonly<CompactThriftField>>): void {
  const expected = ['1', '2', '3', '8', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6']
  const actual = [...fields.keys()].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Parquet page header fields are not exact')
  }
  for (const path of expected) {
    const expectedType = path === '8' ? THRIFT_STRUCT : THRIFT_I32
    if (fields.get(path)?.type !== expectedType) {
      throw new Error('Parquet page header field type is invalid')
    }
  }
}

function requireCompactInteger(
  fields: ReadonlyMap<string, Readonly<CompactThriftField>>,
  path: string,
): number {
  const value = fields.get(path)?.value
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Parquet page header integer is invalid')
  }
  return value
}

function pageUncompressedLimit(
  column: (typeof RECORD_JSON_V1_COLUMNS)[number],
  groupRows: number,
  limits: Readonly<V2DatasetLimits>,
): number {
  if (column === 'record_id') return Math.min(Number.MAX_SAFE_INTEGER, groupRows * 72)
  if (column === 'record_digest') return Math.min(Number.MAX_SAFE_INTEGER, groupRows * 68)
  const effectiveRecordLimit = Math.min(limits.max_record_bytes, limits.max_canonical_bytes)
  const estimatedPageLimit = checkedLimitSum(
    RECORD_JSON_V1_DATA_PAGE_SIZE * 3,
    RECORD_JSON_V1_ROW_GROUP_SIZE * 4,
  )
  return Math.max(checkedLimitSum(effectiveRecordLimit, 4), estimatedPageLimit)
}

function admitMetadataCount(value: bigint, limit: number): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(limit)) {
    throw new ResourceLimitError('Parquet row count exceeds the dataset record limit', {
      resource: 'records',
      limit,
      actual: value.toString(),
    })
  }
  return Number(value)
}

function checkedAddCanonicalBytes(current: number, next: number, limit: number): number {
  if (next > Number.MAX_SAFE_INTEGER - current) {
    throw new ResourceLimitError('Parquet record JSON exceeds the canonical byte limit', {
      resource: 'canonical_bytes',
      limit,
      actual: (BigInt(current) + BigInt(next)).toString(),
    })
  }
  const total = current + next
  if (total > limit) {
    throw new ResourceLimitError('Parquet record JSON exceeds the canonical byte limit', {
      resource: 'canonical_bytes',
      limit,
      actual: total,
    })
  }
  return total
}

function* consumeRecords(
  records: Array<PostTrainingRecordV2 | undefined>,
): Iterable<PostTrainingRecordV2> {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    records[index] = undefined
    if (!record) {
      throw integrity('record_json_invalid', 'Decoded record buffer is incomplete', {
        row_index: index,
      })
    }
    yield record
  }
}

function assertExpectedDatasetIdentity(
  dataset: V2Dataset,
  expected: Readonly<DatasetSnapshotIdentityV2>,
): void {
  const actual = dataset.identity
  if (
    actual.identity_profile !== expected.identity_profile ||
    actual.record_schema_version !== expected.record_schema_version ||
    actual.num_records !== expected.num_records ||
    actual.dataset_version !== expected.dataset_version
  ) {
    throw integrity(
      'dataset_identity_mismatch',
      'Decoded dataset identity does not match the expected identity',
    )
  }
}

function requireStringColumn(
  row: Readonly<Record<string, unknown>>,
  column: (typeof RECORD_JSON_V1_COLUMNS)[number],
  rowIndex: number,
): string {
  const value = row[column]
  if (value === null || value === undefined) {
    throw integrity('null_value', 'Parquet record-json-v1 columns cannot contain null', {
      row_index: rowIndex,
      column,
    })
  }
  if (typeof value !== 'string') {
    throw integrity('schema_mismatch', 'Parquet record-json-v1 column is not a string', {
      row_index: rowIndex,
      column,
    })
  }
  return value
}

function assertPhysicalOrder(
  previous: RecordJsonV1Row | undefined,
  current: RecordJsonV1Row,
  rowIndex: number,
): void {
  if (previous && compareRecordJsonRows(previous, current) >= 0) {
    throw integrity('row_order_mismatch', 'Parquet rows are not in strict digest/ID order', {
      row_index: rowIndex,
    })
  }
}

function compareRecordJsonRows(left: RecordJsonV1Row, right: RecordJsonV1Row): number {
  if (left.record_digest < right.record_digest) return -1
  if (left.record_digest > right.record_digest) return 1
  if (left.record_id < right.record_id) return -1
  if (left.record_id > right.record_id) return 1
  return 0
}

function rethrowIdentityIntegrity(error: unknown, rowIndex: number): never {
  if (error instanceof DuplicateRecordIdErrorV2) {
    throw integrity('duplicate_record_id', 'record-json-v1 contains a duplicate logical ID', {
      row_index: rowIndex,
      column: 'record_id',
    })
  }
  if (error instanceof RecordDigestCollisionErrorV2) {
    throw integrity('digest_collision', 'record-json-v1 contains a record digest collision', {
      row_index: rowIndex,
      column: 'record_digest',
    })
  }
  throw error
}

function validateDecodeOptions(options: DecodeRecordJsonV1Options): ValidatedDecodeOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('record-json-v1 decode options must be an object')
  }
  const expected = options.expectedIdentity
  if (expected === null || typeof expected !== 'object') {
    throw new TypeError('expectedIdentity must be a dataset snapshot identity')
  }
  validateAbortSignal(options.signal)
  const keys = Object.keys(expected).sort()
  const expectedKeys = [
    'dataset_version',
    'identity_profile',
    'num_records',
    'record_schema_version',
  ]
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError('expectedIdentity must contain exactly the snapshot identity fields')
  }
  const expectedIdentity = Object.freeze({
    identity_profile: expected.identity_profile,
    record_schema_version: expected.record_schema_version,
    dataset_version: expected.dataset_version,
    num_records: expected.num_records,
  })
  if (
    expectedIdentity.identity_profile !== V2_IDENTITY_PROFILE ||
    expectedIdentity.record_schema_version !== V2_RECORD_SCHEMA_VERSION ||
    !DigestHexV2Schema.safeParse(expectedIdentity.dataset_version).success ||
    !Number.isSafeInteger(expectedIdentity.num_records) ||
    expectedIdentity.num_records < 0
  ) {
    throw new TypeError('expectedIdentity is not a supported v2 snapshot identity')
  }

  const limits = snapshotLimits(options.limits ?? DEFAULT_V2_DATASET_LIMITS)
  if (expectedIdentity.num_records > limits.max_records) {
    throw new ResourceLimitError('Expected dataset count exceeds the record limit', {
      resource: 'records',
      limit: limits.max_records,
      actual: expectedIdentity.num_records,
    })
  }
  return Object.freeze({
    expectedIdentity,
    limits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

function snapshotLimits(limits: V2DatasetLimits): Readonly<V2DatasetLimits> {
  if (limits === null || typeof limits !== 'object') {
    throw new TypeError('V2 dataset limits must be an object')
  }
  const snapshot = {
    max_records: limits.max_records,
    max_canonical_bytes: limits.max_canonical_bytes,
    max_record_bytes: limits.max_record_bytes,
  }
  for (const [name, value] of Object.entries(snapshot)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`)
    }
  }
  return Object.freeze(snapshot)
}

function validateOutputPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('record-json-v1 output path must be a non-empty string')
  }
}

function validateInputPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('record-json-v1 input path must be a non-empty string')
  }
}

function validateFileHandle(handle: FileHandle): void {
  if (
    handle === null ||
    typeof handle !== 'object' ||
    !Number.isInteger(handle.fd) ||
    typeof handle.stat !== 'function' ||
    typeof handle.read !== 'function'
  ) {
    throw new TypeError('record-json-v1 requires an open FileHandle')
  }
}

function ensureZstdInitialized(): Promise<void> {
  zstdInitialization ??= initializeZstd()
  return zstdInitialization
}

function compressRecordJsonPage(input: Uint8Array): Uint8Array {
  return compressZstd(input, RECORD_JSON_V1_ZSTD_LEVEL)
}

function createBoundedZstdDecompressor(
  limits: Readonly<V2DatasetLimits>,
): (input: Uint8Array, outputLength: number) => Uint8Array {
  const effectiveRecordLimit = Math.min(limits.max_record_bytes, limits.max_canonical_bytes)
  const estimatedPageLimit = checkedLimitSum(
    RECORD_JSON_V1_DATA_PAGE_SIZE * 3,
    RECORD_JSON_V1_ROW_GROUP_SIZE * 4,
  )
  const maxOutputLength = Math.max(estimatedPageLimit, checkedLimitSum(effectiveRecordLimit, 4))
  return (input, outputLength) => decompressZstdBounded(input, outputLength, maxOutputLength)
}

function decompressZstdBounded(
  input: Uint8Array,
  outputLength: number,
  maxOutputLength: number,
): Uint8Array {
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > maxOutputLength) {
    throw new ResourceLimitError('Parquet page exceeds the bounded decode size', {
      resource: 'parquet_page_bytes',
      limit: maxOutputLength,
      actual: outputLength,
    })
  }
  const compressedLengthLimit = zstdCompressBound(outputLength)
  if (input.byteLength > compressedLengthLimit) {
    throw new ResourceLimitError('Compressed ZSTD page exceeds its bounded input size', {
      resource: 'parquet_page_compressed_bytes',
      limit: compressedLengthLimit,
      actual: input.byteLength,
    })
  }

  const declaredContentSize = readZstdFrameContentSize(input)
  if (declaredContentSize !== undefined && declaredContentSize > BigInt(maxOutputLength)) {
    throw new ResourceLimitError('ZSTD frame exceeds the bounded decode size', {
      resource: 'parquet_page_bytes',
      limit: maxOutputLength,
      actual: declaredContentSize.toString(),
    })
  }
  if (declaredContentSize !== undefined && declaredContentSize !== BigInt(outputLength)) {
    throw new Error('ZSTD frame length does not match Parquet metadata')
  }

  // The dependency allocates either the frame-declared size or defaultHeapSize.
  // The header admission above bounds the former; this option bounds frames
  // whose content size is intentionally absent.
  const decoded = decompressZstd(input, { defaultHeapSize: outputLength })
  if (decoded.byteLength !== outputLength) {
    throw new Error('ZSTD page length does not match Parquet metadata')
  }
  return decoded
}

function readZstdFrameContentSize(input: Uint8Array): bigint | undefined {
  if (input.byteLength < 5) throw new Error('ZSTD frame header is truncated')
  if (readLittleEndian(input, 0, 4) !== 0xfd2fb528n) {
    throw new Error('ZSTD frame magic is invalid or unsupported')
  }

  const descriptor = input[4]
  if (descriptor === undefined || (descriptor & 0x18) !== 0) {
    throw new Error('ZSTD frame descriptor is invalid')
  }
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryIdFlag = descriptor & 0x03
  let offset = 5 + (singleSegment ? 0 : 1)
  const dictionaryIdSize = [0, 1, 2, 4][dictionaryIdFlag]
  if (dictionaryIdSize === undefined) throw new Error('ZSTD dictionary header is invalid')
  offset += dictionaryIdSize

  const contentSizeBytes =
    contentSizeFlag === 0
      ? singleSegment
        ? 1
        : 0
      : contentSizeFlag === 1
        ? 2
        : 2 ** contentSizeFlag
  if (contentSizeBytes === 0) {
    if (offset > input.byteLength) throw new Error('ZSTD frame header is truncated')
    return undefined
  }
  if (offset + contentSizeBytes > input.byteLength) {
    throw new Error('ZSTD frame content-size header is truncated')
  }
  const encoded = readLittleEndian(input, offset, contentSizeBytes)
  return contentSizeFlag === 1 ? encoded + 256n : encoded
}

function readLittleEndian(input: Uint8Array, offset: number, length: number): bigint {
  let value = 0n
  for (let index = length - 1; index >= 0; index -= 1) {
    const byte = input[offset + index]
    if (byte === undefined) throw new Error('binary field is truncated')
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

function rethrowFileIoOrAbort(error: unknown): void {
  if (error instanceof ResourceLimitError) {
    throw error
  }
  if (error instanceof Error && error.name === 'AbortError') {
    throw error
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'syscall' in error &&
    typeof error.syscall === 'string'
  ) {
    throw error
  }
}

async function asyncBufferFromHandle(
  handle: FileHandle,
  limits: Readonly<V2DatasetLimits>,
  expectedRecords: number,
  signal?: AbortSignal,
): Promise<HandleAsyncBuffer> {
  const snapshot = await handle.stat({ bigint: true })
  if (!snapshot.isFile()) {
    throw new TypeError('record-json-v1 input path must be a regular file')
  }
  const artifactSizeLimit = artifactDecodeSizeLimit(limits)
  if (snapshot.size > BigInt(artifactSizeLimit)) {
    throw new ResourceLimitError('Parquet artifact exceeds the bounded decode size', {
      resource: 'artifact_size_bytes',
      limit: artifactSizeLimit,
      actual: snapshot.size.toString(),
    })
  }
  const byteLength = Number(snapshot.size)
  if (byteLength < 12) {
    throw integrity('parquet_unreadable', 'Parquet artifact is too short')
  }
  const [header, footer] = await Promise.all([
    readHandleRange(handle, 0, PARQUET_MAGIC.byteLength, signal),
    readHandleRange(handle, byteLength - 8, 8, signal),
  ])
  if (!header.equals(PARQUET_MAGIC) || !footer.subarray(4).equals(PARQUET_MAGIC)) {
    throw integrity('parquet_unreadable', 'Parquet artifact magic is invalid')
  }
  const metadataLength = footer.readUInt32LE(0)
  if (metadataLength > RECORD_JSON_V1_MAX_FOOTER_SIZE || metadataLength + 12 > byteLength) {
    throw integrity('parquet_unreadable', 'Parquet footer length is invalid')
  }
  const metadataOffset = byteLength - metadataLength - 8
  const metadataBytes = await readHandleRange(handle, metadataOffset, metadataLength, signal)
  const expectedRowGroups = Math.ceil(expectedRecords / RECORD_JSON_V1_ROW_GROUP_SIZE)
  const maximumCollectionLength = Math.min(
    RECORD_JSON_V1_MAX_FOOTER_COLLECTION_ELEMENTS,
    Math.max(4, expectedRowGroups),
  )
  const maximumCollectionElements = Math.min(
    RECORD_JSON_V1_MAX_FOOTER_COLLECTION_ELEMENTS,
    checkedLimitSum(16, expectedRowGroups * 16),
  )
  const maximumFields = Math.min(
    RECORD_JSON_V1_MAX_FOOTER_COLLECTION_ELEMENTS,
    checkedLimitSum(64, expectedRowGroups * 64),
  )
  const maximumStructs = Math.min(
    RECORD_JSON_V1_MAX_FOOTER_COLLECTION_ELEMENTS,
    checkedLimitSum(16, expectedRowGroups * 16),
  )
  try {
    const scan = preflightCompactThrift(metadataBytes, {
      maxDepth: 32,
      maxCollectionLength: maximumCollectionLength,
      maxTotalCollectionElements: maximumCollectionElements,
      maxBinaryLength: RECORD_JSON_V1_MAX_FOOTER_SIZE,
      maxTotalFields: maximumFields,
      maxTotalStructs: maximumStructs,
    })
    if (scan.byteLength !== metadataLength) {
      throw new Error('Compact Thrift footer has trailing bytes')
    }
  } catch {
    throw integrity('parquet_unreadable', 'Parquet footer metadata exceeds its structural budget')
  }

  return Object.freeze({
    byteLength,
    metadataOffset,
    snapshot,
    async slice(start: number, end = byteLength): Promise<ArrayBuffer> {
      signal?.throwIfAborted()
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > byteLength
      ) {
        throw new RangeError('Parquet reader requested an invalid file range')
      }
      const buffer = await readHandleRange(handle, start, end - start, signal)
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer
    },
  })
}

async function readHandleRange(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < buffer.byteLength) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    )
    if (bytesRead === 0) {
      throw integrity('parquet_unreadable', 'Parquet artifact changed while it was read')
    }
    offset += bytesRead
  }
  signal?.throwIfAborted()
  return buffer
}

function artifactDecodeSizeLimit(limits: Readonly<V2DatasetLimits>): number {
  const total =
    BigInt(limits.max_canonical_bytes) +
    BigInt(limits.max_records) * BigInt(RECORD_JSON_V1_ROW_PHYSICAL_OVERHEAD_BYTES) +
    BigInt(RECORD_JSON_V1_ARTIFACT_OVERHEAD_BYTES)
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total)
}

function checkedLimitSum(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right
}

function zstdCompressBound(sourceLength: number): number {
  if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) {
    throw new TypeError('ZSTD source length must be a non-negative safe integer')
  }
  const source = BigInt(sourceLength)
  const lowSizeMargin = source < 128n * 1024n ? (128n * 1024n - source) >> 11n : 0n
  const bound = source + (source >> 8n) + lowSizeMargin
  return bound > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bound)
}

async function assertPathStillReferencesHandle(path: string, handle: FileHandle): Promise<void> {
  const [pathStat, handleStat] = await Promise.all([
    stat(path, { bigint: true }),
    handle.stat({ bigint: true }),
  ])
  if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
    throw integrity('parquet_unreadable', 'record-json-v1 output path changed during encoding')
  }
}

async function assertHandleSnapshotUnchanged(
  handle: FileHandle,
  before: BigIntStats,
): Promise<void> {
  const after = await handle.stat({ bigint: true })
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw integrity('parquet_unreadable', 'record-json-v1 artifact changed while it was decoded')
  }
}

function validateAbortSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
}

function hasExactOwnKeys(value: unknown, expectedKeys: readonly string[]): boolean {
  if (value === null || typeof value !== 'object') return false
  const actualKeys = Object.keys(value).sort()
  const sortedExpected = [...expectedKeys].sort()
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  )
}

function integrity(
  reason: RecordJsonV1IntegrityReason,
  message: string,
  detail: Omit<RecordJsonV1IntegrityDetail, 'layout_version' | 'reason'> = {},
): RecordJsonV1IntegrityError {
  return new RecordJsonV1IntegrityError(reason, message, detail)
}
