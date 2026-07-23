import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CapacityExceededError,
  type PostTrainingRecordV2,
  ResourceLimitError,
} from '@databench/schema'
import { describe, expect, test } from 'vitest'
import {
  admitV2TransformWorkingSet,
  DEFAULT_V2_DATASET_LIMITS,
  DuplicateRecordIdErrorV2,
  estimateV2TransformWorkingSet,
  RecordDigestCollisionErrorV2,
  V2Dataset,
  type V2DatasetLimits,
} from '../src/index.js'
import { assertV2RecordIdentityAvailable } from '../src/v2/dataset-invariants.js'

const fixturePath = fileURLToPath(
  new URL('./golden/fixtures/v2/dataset-permutation-and-limits.fixture.json', import.meta.url),
)

interface DatasetFixture {
  records: PostTrainingRecordV2[]
  expected: {
    record_json: string[]
    record_digests: string[]
    record_utf8_bytes: number[]
    iteration_record_ids: string[]
    dataset_version: string
    total_canonical_bytes: number
  }
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as DatasetFixture
const permissiveLimits: V2DatasetLimits = {
  max_records: Number.MAX_SAFE_INTEGER,
  max_canonical_bytes: Number.MAX_SAFE_INTEGER,
  max_record_bytes: Number.MAX_SAFE_INTEGER,
}

describe('V2Dataset identity and ordering', () => {
  test('matches independently generated record and dataset vectors for every permutation', () => {
    for (const records of permutations(fixture.records)) {
      const dataset = V2Dataset.fromRecords(records, permissiveLimits)
      const revisions = [...dataset.records()]

      expect(dataset.identity).toEqual({
        identity_profile: 'databench-v2-jcs-1',
        record_schema_version: '2.0.0',
        dataset_version: fixture.expected.dataset_version,
        num_records: fixture.records.length,
      })
      expect(dataset.version).toBe(fixture.expected.dataset_version)
      expect(dataset.length).toBe(fixture.records.length)
      expect(dataset.canonicalBytes).toBe(fixture.expected.total_canonical_bytes)
      expect(revisions.map((revision) => revision.record.id)).toEqual(
        fixture.expected.iteration_record_ids,
      )

      const byId = new Map(revisions.map((revision) => [revision.record.id, revision]))
      fixture.records.forEach((record, index) => {
        expect(byId.get(record.id)).toMatchObject({
          record_json: fixture.expected.record_json[index],
          record_digest: fixture.expected.record_digests[index],
        })
      })
    }
  })

  test('keeps the empty fixed vector and excludes limits from identity', () => {
    expect(DEFAULT_V2_DATASET_LIMITS).toEqual({
      max_records: 100_000,
      max_canonical_bytes: 512 * 1024 * 1024,
      max_record_bytes: 16 * 1024 * 1024,
    })
    expect(Object.isFrozen(DEFAULT_V2_DATASET_LIMITS)).toBe(true)

    const empty = V2Dataset.fromRecords([], {
      max_records: 0,
      max_canonical_bytes: 0,
      max_record_bytes: 0,
    })
    expect(empty.identity).toEqual({
      identity_profile: 'databench-v2-jcs-1',
      record_schema_version: '2.0.0',
      dataset_version: 'da99cf8da850355f9bae66e9c38a2c61f62e7d59d7aa43a4ff6151bcdae8fefd',
      num_records: 0,
    })
    expect(empty.canonicalBytes).toBe(0)

    const exact = V2Dataset.fromRecords(fixture.records, {
      max_records: fixture.records.length,
      max_canonical_bytes: fixture.expected.total_canonical_bytes,
      max_record_bytes: Math.max(...fixture.expected.record_utf8_bytes),
    })
    expect(exact.version).toBe(fixture.expected.dataset_version)
  })

  test('locks every fixture record canonical UTF-8 byte count', () => {
    fixture.records.forEach((record, index) => {
      expect(V2Dataset.fromRecords([record], permissiveLimits).canonicalBytes).toBe(
        fixtureExpected(fixture.expected.record_utf8_bytes, index),
      )
    })
  })

  test('supports exact lookup and deterministic validated pagination', () => {
    const dataset = V2Dataset.fromRecords(fixture.records, permissiveLimits)
    const ordered = [...dataset.records()]
    const target = fixtureRecord(1)

    expect([...dataset.records(1, 1)]).toEqual([ordered[1]])
    expect([...dataset.records(0, 0)]).toEqual([])
    expect([...dataset.records(99)]).toEqual([])
    expect(dataset.get(target.id)).toBe(
      ordered.find((revision) => revision.record.id === target.id),
    )
    expect(dataset.get('not-a-record-id')).toBeNull()

    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => dataset.records(invalid)).toThrow(TypeError)
      expect(() => dataset.records(0, invalid)).toThrow(TypeError)
    }
  })
})

describe('V2Dataset admission', () => {
  test('incrementally materializes an async source with the same identity', async () => {
    async function* records(): AsyncIterableIterator<PostTrainingRecordV2> {
      for (const record of fixture.records) {
        yield structuredClone(record)
      }
    }

    const asynchronous = await V2Dataset.fromAsyncRecords(records(), permissiveLimits)
    const synchronous = V2Dataset.fromRecords(fixture.records, permissiveLimits)
    expect(asynchronous.identity).toEqual(synchronous.identity)
    expect(asynchronous.canonicalBytes).toBe(synchronous.canonicalBytes)
    expect([...asynchronous.records()].map((revision) => revision.record_digest)).toEqual(
      [...synchronous.records()].map((revision) => revision.record_digest),
    )
  })

  test('stops and closes an async source at the real eager record limit', async () => {
    let pulls = 0
    let closed = false
    async function* records(): AsyncIterableIterator<PostTrainingRecordV2> {
      try {
        for (const record of fixture.records) {
          pulls += 1
          yield record
        }
      } finally {
        closed = true
      }
    }

    await expect(
      V2Dataset.fromAsyncRecords(records(), {
        ...permissiveLimits,
        max_records: 2,
      }),
    ).rejects.toMatchObject({
      name: 'ResourceLimitError',
      code: 'resource_limit',
      detail: { resource: 'records', limit: 2, actual: 3 },
    })
    expect(pulls).toBe(3)
    expect(closed).toBe(true)
  })

  test('validates async limits before pulling and closes on cancellation', async () => {
    let pulls = 0
    let closed = false
    async function* records(): AsyncIterableIterator<PostTrainingRecordV2> {
      try {
        for (const record of fixture.records) {
          pulls += 1
          yield record
        }
      } finally {
        closed = true
      }
    }

    await expect(
      V2Dataset.fromAsyncRecords(records(), {
        ...permissiveLimits,
        max_records: -1,
      }),
    ).rejects.toThrow(TypeError)
    expect(pulls).toBe(0)

    const controller = new AbortController()
    async function* abortingRecords(): AsyncIterableIterator<PostTrainingRecordV2> {
      try {
        pulls += 1
        yield fixtureRecord(0)
        controller.abort()
        pulls += 1
        yield fixtureRecord(1)
      } finally {
        closed = true
      }
    }
    await expect(
      V2Dataset.fromAsyncRecords(abortingRecords(), permissiveLimits, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(pulls).toBe(2)
    expect(closed).toBe(true)
  })

  test('does not publish an async snapshot cancelled while its source finishes', async () => {
    const controller = new AbortController()
    async function* records(): AsyncIterableIterator<PostTrainingRecordV2> {
      yield fixtureRecord(0)
      controller.abort()
    }

    await expect(
      V2Dataset.fromAsyncRecords(records(), permissiveLimits, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('accepts exact record, total byte, and count limits', () => {
    const dataset = V2Dataset.fromRecords(fixture.records, {
      max_records: fixture.records.length,
      max_canonical_bytes: fixture.expected.total_canonical_bytes,
      max_record_bytes: Math.max(...fixture.expected.record_utf8_bytes),
    })
    expect(dataset.length).toBe(3)
  })

  test('rejects a record one UTF-8 byte over the single-record limit', () => {
    const unicodeIndex = 1
    const unicodeBytes = fixtureExpected(fixture.expected.record_utf8_bytes, unicodeIndex)
    const unicodeJson = fixtureExpected(fixture.expected.record_json, unicodeIndex)
    expect(unicodeJson.length).toBeLessThan(unicodeBytes)

    let closed = false
    function* records() {
      try {
        yield fixtureRecord(unicodeIndex)
        throw new Error('must not pull beyond the oversized record')
      } finally {
        closed = true
      }
    }

    expect(() =>
      V2Dataset.fromRecords(records(), {
        ...permissiveLimits,
        max_record_bytes: unicodeBytes - 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'ResourceLimitError',
        code: 'resource_limit',
        detail: {
          resource: 'record_bytes',
          limit: unicodeBytes - 1,
          actual: unicodeBytes,
        },
      }),
    )
    expect(closed).toBe(true)
  })

  test('rejects total canonical bytes and record count one over their limits', () => {
    const firstTwoBytes =
      fixtureExpected(fixture.expected.record_utf8_bytes, 0) +
      fixtureExpected(fixture.expected.record_utf8_bytes, 1)
    let totalClosed = false
    function* totalRecords() {
      try {
        yield fixtureRecord(0)
        yield fixtureRecord(1)
        throw new Error('must not pull beyond the record that exceeds total bytes')
      } finally {
        totalClosed = true
      }
    }

    expect(() =>
      V2Dataset.fromRecords(totalRecords(), {
        ...permissiveLimits,
        max_canonical_bytes: firstTwoBytes - 1,
      }),
    ).toThrow(ResourceLimitError)
    expect(totalClosed).toBe(true)

    let closed = false
    function* records() {
      try {
        yield fixtureRecord(0)
        yield { invalid: true }
        throw new Error('must not pull beyond the rejected record')
      } finally {
        closed = true
      }
    }

    expect(() =>
      V2Dataset.fromRecords(records(), {
        ...permissiveLimits,
        max_records: 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'resource_limit',
        detail: { resource: 'records', limit: 1, actual: 2 },
      }),
    )
    expect(closed).toBe(true)
  })

  test('rejects a non-empty input when max_records is zero before record parsing', () => {
    expect(() =>
      V2Dataset.fromRecords([{ invalid: true }], {
        ...permissiveLimits,
        max_records: 0,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'resource_limit',
        detail: { resource: 'records', limit: 0, actual: 1 },
      }),
    )
  })

  test('validates limits before consuming the input iterable', () => {
    let consumed = false
    const records: Iterable<unknown> = {
      [Symbol.iterator]() {
        consumed = true
        throw new Error('iterator must not be consumed')
      },
    }

    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() =>
        V2Dataset.fromRecords(records, {
          ...permissiveLimits,
          max_records: invalid,
        }),
      ).toThrow(TypeError)
      expect(consumed).toBe(false)
    }
  })

  test('snapshots each limit exactly once before dataset construction', () => {
    const reads = { records: 0, total: 0, record: 0 }
    const limits = {
      get max_records() {
        reads.records += 1
        return 0
      },
      get max_canonical_bytes() {
        reads.total += 1
        return 0
      },
      get max_record_bytes() {
        reads.record += 1
        return 0
      },
    }

    expect(V2Dataset.fromRecords([], limits).length).toBe(0)
    expect(reads).toEqual({ records: 1, total: 1, record: 1 })
  })
})

describe('V2Dataset set invariants and immutability', () => {
  test('rejects an exact duplicate and a second revision of the same logical ID', () => {
    const record = fixtureRecord(0)
    expect(() => V2Dataset.fromRecords([record, record], permissiveLimits)).toThrowError(
      expect.objectContaining({
        name: 'DuplicateRecordIdErrorV2',
        code: 'validation_error',
        detail: {
          issues: [
            {
              path: '/records/1/id',
              line: null,
              code: 'duplicate_record_id',
              message: 'Logical record ID must be unique within a dataset',
            },
          ],
        },
      }),
    )

    const changed = structuredClone(record)
    changed.extra = { changed: true }
    expect(() => V2Dataset.fromRecords([record, changed], permissiveLimits)).toThrow(
      DuplicateRecordIdErrorV2,
    )
  })

  test('allows semantically equal records with distinct logical IDs', () => {
    const first = structuredClone(fixtureRecord(0))
    const second = structuredClone(first)
    second.id = fixtureRecord(2).id

    expect(V2Dataset.fromRecords([first, second], permissiveLimits).length).toBe(2)
  })

  test('detects a simulated digest collision without mutating caller indexes', () => {
    const digest = 'a'.repeat(64)
    const recordIds = new Set(['rec_existing'])
    const canonicalByDigest = new Map([[digest, '{"value":1}']])

    expect(() =>
      assertV2RecordIdentityAvailable(
        {
          record_id: 'rec_new',
          record_digest: digest,
          record_json: '{"value":2}',
        },
        recordIds,
        canonicalByDigest,
      ),
    ).toThrow(RecordDigestCollisionErrorV2)
    expect([...recordIds]).toEqual(['rec_existing'])
    expect([...canonicalByDigest]).toEqual([[digest, '{"value":1}']])
  })

  test('defensively owns frozen revisions, identity, and iteration snapshots', () => {
    const input = structuredClone(fixtureRecord(0))
    const dataset = V2Dataset.fromRecords([input], permissiveLimits)
    const before = dataset.get(input.id)
    if (before === null) {
      throw new Error('fixture revision was not retained')
    }
    const iteration = dataset.records() as readonly unknown[]

    input.extra = { changed_after_build: true }
    expect(before.record.extra).toEqual({ label: 'plain' })
    expect(Object.isFrozen(dataset)).toBe(true)
    expect(Object.isFrozen(dataset.identity)).toBe(true)
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(before.record)).toBe(true)
    expect(Object.isFrozen(iteration)).toBe(true)
    expect(() => ((before.record.extra as { label: string }).label = 'mutated')).toThrow()
    expect(() => ((dataset.identity as { num_records: number }).num_records = 99)).toThrow()
    expect(() => (iteration as unknown[]).push('mutation')).toThrow()
    expect(dataset.version).toBe(
      V2Dataset.fromRecords([fixtureRecord(0)], permissiveLimits).version,
    )
  })

  test('rejects runtime construction outside the validated factory', () => {
    expect(() => Reflect.construct(V2Dataset, [Symbol('forged'), [], 0])).toThrow(
      'V2Dataset must be created with V2Dataset.fromRecords',
    )
  })
})

describe('V2 transform working-set estimation', () => {
  test('uses checked aggregate bytes, counts repeated inputs, and admits the exact budget', () => {
    const dataset = V2Dataset.fromRecords([fixtureRecord(0)], permissiveLimits)
    const input = {
      inputDatasets: [dataset, dataset],
      outputUpperBoundBytes: 2 ** 32,
      frameEstimateBytes: 17,
    }
    const estimate = estimateV2TransformWorkingSet(input)

    expect(estimate).toEqual({
      inputCanonicalBytes: dataset.canonicalBytes * 2,
      outputUpperBoundBytes: 2 ** 32,
      frameEstimateBytes: 17,
      totalBytes: dataset.canonicalBytes * 2 + 2 ** 32 + 17,
    })
    expect(Object.isFrozen(estimate)).toBe(true)
    expect(admitV2TransformWorkingSet(input, estimate.totalBytes)).toEqual(estimate)
    expect(() => admitV2TransformWorkingSet(input, estimate.totalBytes - 1)).toThrow(
      CapacityExceededError,
    )
  })

  test('accepts MAX_SAFE exactly and rejects checked-sum overflow', () => {
    const empty = V2Dataset.fromRecords([])
    expect(
      estimateV2TransformWorkingSet({
        inputDatasets: [empty],
        outputUpperBoundBytes: Number.MAX_SAFE_INTEGER,
        frameEstimateBytes: 0,
      }).totalBytes,
    ).toBe(Number.MAX_SAFE_INTEGER)

    expect(() =>
      estimateV2TransformWorkingSet({
        inputDatasets: [],
        outputUpperBoundBytes: Number.MAX_SAFE_INTEGER,
        frameEstimateBytes: 1,
      }),
    ).toThrow(ResourceLimitError)
  })

  test('rejects invalid components and budgets', () => {
    const empty = V2Dataset.fromRecords([])
    const valid = {
      inputDatasets: [empty],
      outputUpperBoundBytes: 0,
      frameEstimateBytes: 0,
    }

    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() =>
        estimateV2TransformWorkingSet({ ...valid, outputUpperBoundBytes: invalid }),
      ).toThrow(TypeError)
      expect(() =>
        estimateV2TransformWorkingSet({ ...valid, frameEstimateBytes: invalid }),
      ).toThrow(TypeError)
      expect(() => admitV2TransformWorkingSet(valid, invalid)).toThrow(TypeError)
    }

    expect(() =>
      estimateV2TransformWorkingSet({
        ...valid,
        inputDatasets: [{} as V2Dataset],
      }),
    ).toThrow(TypeError)
  })
})

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) {
    return [[...values]]
  }
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  )
}

function fixtureRecord(index: number): PostTrainingRecordV2 {
  return fixtureExpected(fixture.records, index)
}

function fixtureExpected<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) {
    throw new Error(`fixture value ${index} is missing`)
  }
  return value
}
