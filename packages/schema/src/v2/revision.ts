import {
  canonicalJsonV2,
  hashV2DatasetIdentityFromSortedRecordDigests,
  hashV2Record,
} from '@databench/hashing'
import type { PostTrainingRecordV2 } from './record.js'
import { PostTrainingRecordV2Schema } from './record.js'

export type DeepReadonly<T> = T extends null | boolean | number | string
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

const recordRevisionInstances = new WeakSet<object>()

class RecordRevisionV2Value {
  readonly #brand = true

  constructor(
    readonly record: DeepReadonly<PostTrainingRecordV2>,
    readonly record_json: string,
    readonly record_digest: string,
  ) {
    void this.#brand
    recordRevisionInstances.add(this)
    Object.freeze(this)
  }
}

export type RecordRevisionV2 = RecordRevisionV2Value

export function isRecordRevisionV2(value: unknown): value is RecordRevisionV2 {
  return typeof value === 'object' && value !== null && recordRevisionInstances.has(value)
}

export function createRecordRevisionV2(input: unknown): RecordRevisionV2 {
  let cloned: unknown
  try {
    cloned = structuredClone(input)
  } catch {
    throw new TypeError('Canonical record must be structured-cloneable JSON data')
  }

  const parsed = PostTrainingRecordV2Schema.parse(cloned)
  const record = deepFreeze(parsed)
  const recordJson = canonicalJsonV2(record)
  const recordDigest = hashV2Record(record)

  return new RecordRevisionV2Value(record, recordJson, recordDigest)
}

/**
 * Returns the canonical dataset identity for revisions already ordered by
 * `(record_digest, record_id)`, using constant additional memory.
 */
export function datasetVersionForSortedRecordRevisionsV2(
  revisions: readonly RecordRevisionV2[],
): string {
  function* recordDigests(): IterableIterator<string> {
    let previous: RecordRevisionV2 | null = null
    for (const revision of revisions) {
      if (!isRecordRevisionV2(revision)) {
        throw new TypeError('Dataset identity requires RecordRevisionV2 values')
      }
      if (previous !== null && compareRevisionIdentity(previous, revision) > 0) {
        throw new TypeError('Dataset identity revisions must be sorted')
      }
      previous = revision
      yield revision.record_digest
    }
  }

  return hashV2DatasetIdentityFromSortedRecordDigests(recordDigests())
}

function compareRevisionIdentity(left: RecordRevisionV2, right: RecordRevisionV2): number {
  if (left.record_digest !== right.record_digest) {
    return left.record_digest < right.record_digest ? -1 : 1
  }
  if (left.record.id === right.record.id) return 0
  return left.record.id < right.record.id ? -1 : 1
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as DeepReadonly<T>
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return Object.freeze(value) as DeepReadonly<T>
}
