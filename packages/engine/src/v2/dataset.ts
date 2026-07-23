import {
  hashV2DatasetIdentity,
  V2_IDENTITY_PROFILE,
  V2_RECORD_SCHEMA_VERSION,
} from '@databench/hashing'
import {
  CapacityExceededError,
  createRecordRevisionV2,
  DatasetIdentityEnvelopeV2Schema,
  type RecordRevisionV2,
  ResourceLimitError,
} from '@databench/schema'
import {
  assertV2RecordIdentityAvailable,
  DuplicateRecordIdErrorV2,
  RecordDigestCollisionErrorV2,
} from './dataset-invariants.js'

const MEBIBYTE = 1024 * 1024
const textEncoder = new TextEncoder()
const V2_DATASET_CONSTRUCTION = Symbol('V2Dataset construction')

export interface DatasetSnapshotIdentityV2 {
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly record_schema_version: typeof V2_RECORD_SCHEMA_VERSION
  readonly dataset_version: string
  readonly num_records: number
}

export interface V2DatasetLimits {
  readonly max_records: number
  readonly max_canonical_bytes: number
  readonly max_record_bytes: number
}

export interface V2DatasetAsyncOptions {
  readonly signal?: AbortSignal
}

export const DEFAULT_V2_DATASET_LIMITS: Readonly<V2DatasetLimits> = Object.freeze({
  max_records: 100_000,
  max_canonical_bytes: 512 * MEBIBYTE,
  max_record_bytes: 16 * MEBIBYTE,
})

export interface V2TransformWorkingSetInput {
  readonly inputDatasets: readonly V2Dataset[]
  readonly outputUpperBoundBytes: number
  readonly frameEstimateBytes: number
}

export interface V2TransformWorkingSetEstimate {
  readonly inputCanonicalBytes: number
  readonly outputUpperBoundBytes: number
  readonly frameEstimateBytes: number
  readonly totalBytes: number
}

export class V2Dataset {
  readonly identity: Readonly<DatasetSnapshotIdentityV2>
  readonly canonicalBytes: number
  readonly #records: readonly RecordRevisionV2[]
  readonly #recordsById: ReadonlyMap<string, RecordRevisionV2>

  private constructor(
    token: typeof V2_DATASET_CONSTRUCTION,
    records: readonly RecordRevisionV2[],
    canonicalBytes: number,
  ) {
    if (token !== V2_DATASET_CONSTRUCTION) {
      throw new TypeError('V2Dataset must be created with V2Dataset.fromRecords')
    }
    const recordDigests = records.map((revision) => revision.record_digest)
    const envelope = DatasetIdentityEnvelopeV2Schema.parse({
      identity_profile: V2_IDENTITY_PROFILE,
      record_schema_version: V2_RECORD_SCHEMA_VERSION,
      record_digests: recordDigests,
    })
    this.identity = Object.freeze({
      identity_profile: V2_IDENTITY_PROFILE,
      record_schema_version: V2_RECORD_SCHEMA_VERSION,
      dataset_version: hashV2DatasetIdentity(envelope),
      num_records: records.length,
    })
    this.canonicalBytes = canonicalBytes
    this.#records = Object.freeze([...records])
    this.#recordsById = new Map(records.map((revision) => [revision.record.id, revision]))
    Object.freeze(this)
  }

  static fromRecords(
    records: Iterable<unknown>,
    limitsInput: V2DatasetLimits = DEFAULT_V2_DATASET_LIMITS,
  ): V2Dataset {
    const state = createV2DatasetBuildState(limitsInput)

    for (const input of records) {
      appendV2DatasetRecord(state, input)
    }

    return V2Dataset.fromBuildState(state)
  }

  /**
   * Incrementally materializes an eager snapshot from an asynchronous source.
   * Admission runs before the next record is retained, so JSONL callers do not
   * need to buffer the complete transport before applying dataset limits.
   */
  static async fromAsyncRecords(
    records: AsyncIterable<unknown>,
    limitsInput: V2DatasetLimits = DEFAULT_V2_DATASET_LIMITS,
    options: V2DatasetAsyncOptions = {},
  ): Promise<V2Dataset> {
    const state = createV2DatasetBuildState(limitsInput)
    const signal = options.signal
    signal?.throwIfAborted()
    for await (const input of records) {
      signal?.throwIfAborted()
      appendV2DatasetRecord(state, input)
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    return V2Dataset.fromBuildState(state)
  }

  private static fromBuildState(state: V2DatasetBuildState): V2Dataset {
    state.retained.sort(compareRevisionIdentityAscii)
    return new V2Dataset(V2_DATASET_CONSTRUCTION, state.retained, state.canonicalBytes)
  }

  get length(): number {
    return this.identity.num_records
  }

  get version(): string {
    return this.identity.dataset_version
  }

  records(offset = 0, limit?: number): Iterable<RecordRevisionV2> {
    validateNonNegativeSafeInteger('offset', offset)
    if (limit !== undefined) {
      validateNonNegativeSafeInteger('limit', limit)
    }
    if (offset >= this.#records.length) {
      return Object.freeze([])
    }

    const available = this.#records.length - offset
    const take = Math.min(limit ?? available, available)
    return Object.freeze(this.#records.slice(offset, offset + take))
  }

  get(recordId: string): RecordRevisionV2 | null {
    return this.#recordsById.get(recordId) ?? null
  }
}

export function estimateV2TransformWorkingSet(
  input: V2TransformWorkingSetInput,
): Readonly<V2TransformWorkingSetEstimate> {
  validateNonNegativeSafeInteger('outputUpperBoundBytes', input.outputUpperBoundBytes)
  validateNonNegativeSafeInteger('frameEstimateBytes', input.frameEstimateBytes)

  let inputCanonicalBytes = 0
  for (const dataset of input.inputDatasets) {
    if (!(dataset instanceof V2Dataset)) {
      throw new TypeError('inputDatasets must contain only V2Dataset instances')
    }
    inputCanonicalBytes = checkedAdd(
      'inputCanonicalBytes',
      inputCanonicalBytes,
      dataset.canonicalBytes,
    )
  }

  const withOutput = checkedAdd('workingSetBytes', inputCanonicalBytes, input.outputUpperBoundBytes)
  const totalBytes = checkedAdd('workingSetBytes', withOutput, input.frameEstimateBytes)

  return Object.freeze({
    inputCanonicalBytes,
    outputUpperBoundBytes: input.outputUpperBoundBytes,
    frameEstimateBytes: input.frameEstimateBytes,
    totalBytes,
  })
}

export function admitV2TransformWorkingSet(
  input: V2TransformWorkingSetInput,
  budgetBytes: number,
): Readonly<V2TransformWorkingSetEstimate> {
  validateNonNegativeSafeInteger('budgetBytes', budgetBytes)
  const estimate = estimateV2TransformWorkingSet(input)
  if (estimate.totalBytes > budgetBytes) {
    throw new CapacityExceededError('Transform working set exceeds the available byte budget', {
      resource: 'working_set_bytes',
      limit: budgetBytes,
      actual: estimate.totalBytes,
    })
  }
  return estimate
}

export { DuplicateRecordIdErrorV2, RecordDigestCollisionErrorV2 }

interface V2DatasetBuildState {
  readonly limits: Readonly<V2DatasetLimits>
  readonly retained: RecordRevisionV2[]
  readonly recordIds: Set<string>
  readonly canonicalByDigest: Map<string, string>
  canonicalBytes: number
}

function createV2DatasetBuildState(limitsInput: V2DatasetLimits): V2DatasetBuildState {
  return {
    limits: validateV2DatasetLimits(limitsInput),
    retained: [],
    recordIds: new Set<string>(),
    canonicalByDigest: new Map<string, string>(),
    canonicalBytes: 0,
  }
}

function appendV2DatasetRecord(state: V2DatasetBuildState, input: unknown): void {
  if (state.retained.length >= state.limits.max_records) {
    throwDatasetLimit('records', state.limits.max_records, nextActual(state.retained.length, 1))
  }

  const revision = createRecordRevisionV2(input)
  const recordBytes = textEncoder.encode(revision.record_json).byteLength
  if (recordBytes > state.limits.max_record_bytes) {
    throwDatasetLimit('record_bytes', state.limits.max_record_bytes, recordBytes)
  }
  if (recordBytes > state.limits.max_canonical_bytes - state.canonicalBytes) {
    throwDatasetLimit(
      'canonical_bytes',
      state.limits.max_canonical_bytes,
      nextActual(state.canonicalBytes, recordBytes),
    )
  }

  assertV2RecordIdentityAvailable(
    {
      record_id: revision.record.id,
      record_digest: revision.record_digest,
      record_json: revision.record_json,
    },
    state.recordIds,
    state.canonicalByDigest,
    state.retained.length,
  )

  state.canonicalBytes += recordBytes
  state.retained.push(revision)
  state.recordIds.add(revision.record.id)
  state.canonicalByDigest.set(revision.record_digest, revision.record_json)
}

function validateV2DatasetLimits(limits: V2DatasetLimits): Readonly<V2DatasetLimits> {
  if (limits === null || typeof limits !== 'object') {
    throw new TypeError('V2 dataset limits must be an object')
  }
  const maxRecords = limits.max_records
  const maxCanonicalBytes = limits.max_canonical_bytes
  const maxRecordBytes = limits.max_record_bytes
  validateNonNegativeSafeInteger('max_records', maxRecords)
  validateNonNegativeSafeInteger('max_canonical_bytes', maxCanonicalBytes)
  validateNonNegativeSafeInteger('max_record_bytes', maxRecordBytes)
  return Object.freeze({
    max_records: maxRecords,
    max_canonical_bytes: maxCanonicalBytes,
    max_record_bytes: maxRecordBytes,
  })
}

function validateNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

function checkedAdd(name: string, current: number, next: number): number {
  validateNonNegativeSafeInteger(name, current)
  validateNonNegativeSafeInteger(name, next)
  if (next > Number.MAX_SAFE_INTEGER - current) {
    throw new ResourceLimitError(`${name} exceeds the safe integer range`, {
      resource: name,
      limit: Number.MAX_SAFE_INTEGER,
      actual: nextActual(current, next),
    })
  }
  return current + next
}

function nextActual(current: number, next: number): number | string {
  if (next <= Number.MAX_SAFE_INTEGER - current) {
    return current + next
  }
  return (BigInt(current) + BigInt(next)).toString()
}

function throwDatasetLimit(resource: string, limit: number, actual: number | string): never {
  throw new ResourceLimitError(`V2 dataset exceeds the ${resource} limit`, {
    resource,
    limit,
    actual,
  })
}

function compareRevisionIdentityAscii(left: RecordRevisionV2, right: RecordRevisionV2): number {
  if (left.record_digest < right.record_digest) {
    return -1
  }
  if (left.record_digest > right.record_digest) {
    return 1
  }
  if (left.record.id < right.record.id) {
    return -1
  }
  if (left.record.id > right.record.id) {
    return 1
  }
  return 0
}
