import { canonicalJsonV2, hashV2Record } from '@databench/hashing'
import type { PostTrainingRecordV2 } from './record.js'
import { PostTrainingRecordV2Schema } from './record.js'

export type DeepReadonly<T> = T extends null | boolean | number | string
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

class RecordRevisionV2Value {
  readonly #brand = true

  constructor(
    readonly record: DeepReadonly<PostTrainingRecordV2>,
    readonly record_json: string,
    readonly record_digest: string,
  ) {
    void this.#brand
    Object.freeze(this)
  }
}

export type RecordRevisionV2 = RecordRevisionV2Value

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

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as DeepReadonly<T>
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return Object.freeze(value) as DeepReadonly<T>
}
