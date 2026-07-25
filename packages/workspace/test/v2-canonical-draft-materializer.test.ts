import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CatalogIdentityClaimInputV2,
  CatalogIdentityClaimResultV2,
  CatalogIdentityClaimRowV2,
} from '@databench/catalog'
import { V2Dataset } from '@databench/engine'
import { canonicalJsonV2, hashArtifactBytes } from '@databench/hashing'
import { readCanonicalDraftJsonlV1, writeCanonicalJsonlV2 } from '@databench/io'
import { createRecordRevisionV2 } from '@databench/schema'
import { V2TempStore } from '@databench/store'
import { describe, expect, test, vi } from 'vitest'
import {
  materializeCanonicalDraftJsonlV1,
  V2CanonicalDraftIdentityAllocator,
  type V2CanonicalDraftRecordIdentityPlan,
  type V2IdentityAllocatorCatalog,
} from '../src/v2/index.js'

const NAMESPACE_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-07-25T00:00:00.000Z')
const MEBIBYTE = 1024 * 1024
const DATASET_LIMITS = Object.freeze({
  max_records: 100,
  max_canonical_bytes: MEBIBYTE,
  max_record_bytes: MEBIBYTE,
})
const JSONL_LIMITS = Object.freeze({ max_request_bytes: MEBIBYTE, max_nesting_depth: 128 })

interface VectorClaim {
  readonly creation_profile: string
  readonly entity_kind: string
  readonly entity_id: string
  readonly claim_key_digest: string
  readonly request_digest: string
}

interface VectorRow {
  readonly data_row_index: number
  readonly generation_run_id: string
  readonly event_keys: readonly string[]
  readonly root_initial_record_jcs: string
  readonly candidate_initial_jcs: readonly string[]
  readonly record_digest: string
  readonly claims: readonly VectorClaim[]
}

interface CanonicalDraftVector {
  readonly fixture_version: 1
  readonly name: string
  readonly namespace: string
  readonly source_artifact_digest: string
  readonly raw_byte_length: number
  readonly dataset_version: string
  readonly rows: readonly VectorRow[]
}

describe('canonical draft fixed vectors', () => {
  for (const name of ['sft', 'dpo', 'rlvr'] as const) {
    test(`locks ${name.toUpperCase()} owner skeletons, claims, IDs, and canonical bytes`, async () => {
      const vector = await readVector(name)
      const raw = await readFixture(`${vector.name}.input.jsonl`)
      const drafts = await collect(readCanonicalDraftJsonlV1(byteSource(raw)))
      const allocator = new V2CanonicalDraftIdentityAllocator(
        vector.namespace,
        vector.source_artifact_digest,
      )
      const plans = drafts.map((draft, index) => allocator.planRecord(draft, index))
      const dataset = V2Dataset.fromRecords(plans.map(({ record }) => record))
      const canonicalBytes = await collectBytes(writeCanonicalJsonlV2(dataset.records()))

      expect(vector.fixture_version).toBe(1)
      expect(raw.byteLength).toBe(vector.raw_byte_length)
      expect(hashArtifactBytes(raw)).toBe(vector.source_artifact_digest)
      expect(dataset.version).toBe(vector.dataset_version)
      expect(plans.map(projectPlan)).toEqual(vector.rows)
      expect(canonicalBytes).toEqual(await readFixture(`${vector.name}.expected.jsonl`))
    })
  }

  test('locks raw-byte LF, CRLF, leading blank, and no-tail identity boundaries', async () => {
    const line = await readFixture('canonical-draft-rlvr-v1.input.jsonl')
    const noTail = line.subarray(0, line.byteLength - 1)
    const crlf = new TextEncoder().encode(`${new TextDecoder().decode(noTail)}\r\n`)
    const leadingBlank = new Uint8Array([0x0a, ...line])

    expect([
      hashArtifactBytes(line),
      hashArtifactBytes(noTail),
      hashArtifactBytes(crlf),
      hashArtifactBytes(leadingBlank),
    ]).toEqual([
      'a8f8e5d8589fc86b586d7eb7b60cf27ccf92db5ff7568b59bd023a2c66b70fa0',
      '7acdbb1cd8627fa902d4c0adbd10bae60b7ceb1be8bdf98c65107e4d16706083',
      'deb0636838dd8dbb90062ef130f3dc45a65510a2165ac644849f10dd7c0f1343',
      '2f7e55ac2fd33447e45912c126ac2fc25703fca19a9c18034281cd4a5fc929e0',
    ])

    for (const raw of [line, noTail, crlf, leadingBlank]) {
      const [draft] = await collect(readCanonicalDraftJsonlV1(byteSource(raw)))
      if (draft === undefined) throw new Error('raw boundary fixture did not contain a data row')
      const plan = new V2CanonicalDraftIdentityAllocator(
        NAMESPACE_ID,
        hashArtifactBytes(raw),
      ).planRecord(draft, 0)
      expect(plan.dataRowIndex).toBe(0)
    }
  })

  test('orders every candidate claim before signals from any candidate', async () => {
    const raw = await readFixture('canonical-draft-rlvr-v1.input.jsonl')
    const [draft] = await collect(readCanonicalDraftJsonlV1(byteSource(raw)))
    if (draft === undefined) throw new Error('claim order fixture did not contain a data row')
    const plan = new V2CanonicalDraftIdentityAllocator(
      NAMESPACE_ID,
      hashArtifactBytes(raw),
    ).planRecord(
      {
        ...draft,
        candidates: [
          draft.candidates[0],
          {
            ...draft.candidates[0],
            contents: [
              {
                role: 'ai',
                parts: [
                  {
                    type: 'text',
                    text: '43',
                    thought: false,
                    thought_signature: null,
                    part_metadata: {},
                  },
                ],
                loss_weight: 1,
              },
            ],
            rank: 1,
            selected: false,
            signals: [],
          },
        ],
      },
      0,
    )

    expect(plan.claims.map(({ request }) => request.creation_profile)).toEqual([
      'artifact-row-v1',
      'candidate-v1',
      'candidate-v1',
      'signal-event-v1',
      'signal-event-v1',
    ])
    expect(plan.record.candidates[0]?.signals).toHaveLength(2)
    expect(plan.record.candidates[1]?.signals).toEqual([])
  })
})

describe('canonical draft materialization', () => {
  test('seals canonical JSONL, writes only ordered claims, and replays exactly', async () => {
    await withTempStore(async (tempStore, tempRoot) => {
      const vector = await readVector('dpo')
      const raw = await readFixture(`${vector.name}.input.jsonl`)
      const catalog = new ClaimCatalog()

      const first = await materialize(raw, tempStore, catalog, {
        expectedInputDigest: vector.source_artifact_digest,
      })
      expect(first.inputDigest).toBe(vector.source_artifact_digest)
      expect(first.datasetVersion).toBe(vector.dataset_version)
      expect(first.recordCount).toBe(1)
      expect(catalog.claims.map(projectCatalogClaim)).toEqual(vector.rows[0]?.claims)
      expect(catalog.insertOrReadIdentityClaim).toHaveBeenCalledTimes(5)
      expect(await collectBytes(first.bytes)).toEqual(
        await readFixture(`${vector.name}.expected.jsonl`),
      )
      expect(await draftTempFiles(tempRoot)).toEqual([])

      const replay = await materialize(raw, tempStore, catalog)
      expect(await collectBytes(replay.bytes)).toEqual(
        await readFixture(`${vector.name}.expected.jsonl`),
      )
      expect(catalog.claims).toHaveLength(5)
      expect(catalog.insertOrReadIdentityClaim).toHaveBeenCalledTimes(10)
      expect(await draftTempFiles(tempRoot)).toEqual([])
    })
  })

  test('fails expected digest before namespace or claim access and cleans raw spool', async () => {
    await withTempStore(async (tempStore, tempRoot) => {
      const raw = await readFixture('canonical-draft-sft-v1.input.jsonl')
      const catalog = new ClaimCatalog()
      const getNamespace = vi.fn(async () => NAMESPACE_ID)

      await expect(
        materializeCanonicalDraftJsonlV1({
          source: byteSource(raw),
          options: { expectedInputDigest: 'f'.repeat(64) },
          tempStore,
          catalog,
          getNamespace,
          datasetLimits: DATASET_LIMITS,
          jsonlLimits: JSONL_LIMITS,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: 'validation_error',
        detail: { issues: [expect.objectContaining({ code: 'input_digest_mismatch' })] },
      })
      expect(getNamespace).not.toHaveBeenCalled()
      expect(catalog.insertOrReadIdentityClaim).not.toHaveBeenCalled()
      expect(await draftTempFiles(tempRoot)).toEqual([])
    })
  })

  test('never returns a partial stream when a later claim conflicts', async () => {
    await withTempStore(async (tempStore, tempRoot) => {
      const raw = await readFixture('canonical-draft-rlvr-v1.input.jsonl')
      const catalog = new ClaimCatalog()
      catalog.failAtCall = 3

      await expect(materialize(raw, tempStore, catalog)).rejects.toMatchObject({
        code: 'service_unavailable',
      })
      expect(catalog.claims).toHaveLength(2)
      expect(await draftTempFiles(tempRoot)).toEqual([])
    })
  })

  test('cleans sealed output after partial cancellation, dispose, or pre-read abort', async () => {
    await withTempStore(async (tempStore, tempRoot) => {
      const raw = await readFixture('canonical-draft-rlvr-v1.input.jsonl')
      const partial = await materialize(raw, tempStore, new ClaimCatalog())
      const iterator = partial.bytes[Symbol.asyncIterator]()
      expect(await iterator.next()).toMatchObject({ done: false })
      await iterator.return?.()
      expect(await draftTempFiles(tempRoot)).toEqual([])

      const unopened = await materializeCanonicalDraftJsonlV1({
        source: byteSource(raw),
        options: {},
        tempStore,
        catalog: new ClaimCatalog(),
        getNamespace: async () => NAMESPACE_ID,
        datasetLimits: DATASET_LIMITS,
        jsonlLimits: JSONL_LIMITS,
        signal: new AbortController().signal,
      })
      expect(unopened.contentLength).toBeGreaterThan(0)
      expect(await draftTempFiles(tempRoot)).toHaveLength(1)
      await unopened.dispose()
      await unopened.dispose()
      expect(() => unopened.bytes[Symbol.asyncIterator]()).toThrow(/disposed/)
      expect(await draftTempFiles(tempRoot)).toEqual([])

      const controller = new AbortController()
      const aborted = await materializeCanonicalDraftJsonlV1({
        source: byteSource(raw),
        options: {},
        tempStore,
        catalog: new ClaimCatalog(),
        getNamespace: async () => NAMESPACE_ID,
        datasetLimits: DATASET_LIMITS,
        jsonlLimits: JSONL_LIMITS,
        signal: controller.signal,
      })
      expect(aborted.contentLength).toBeGreaterThan(0)
      expect(await draftTempFiles(tempRoot)).toHaveLength(1)
      controller.abort(new DOMException('cancel unopened materialization', 'AbortError'))
      await vi.waitFor(async () => {
        expect(await draftTempFiles(tempRoot)).toEqual([])
      })
    })
  })

  test('observes abort, output capacity, and source-root semantic conflict with cleanup', async () => {
    await withTempStore(async (tempStore, tempRoot) => {
      const raw = await readFixture('canonical-draft-sft-v1.input.jsonl')
      const abortedCatalog = new ClaimCatalog()
      const controller = new AbortController()
      const source = (async function* () {
        yield raw.subarray(0, 32)
        controller.abort(new DOMException('cancel materialize', 'AbortError'))
        yield raw.subarray(32)
      })()
      await expect(
        materializeCanonicalDraftJsonlV1({
          source,
          options: {},
          tempStore,
          catalog: abortedCatalog,
          getNamespace: async () => NAMESPACE_ID,
          datasetLimits: DATASET_LIMITS,
          jsonlLimits: JSONL_LIMITS,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(abortedCatalog.insertOrReadIdentityClaim).not.toHaveBeenCalled()
      expect(await draftTempFiles(tempRoot)).toEqual([])

      const capacityCatalog = new ClaimCatalog()
      await expect(
        materializeCanonicalDraftJsonlV1({
          source: byteSource(raw),
          options: {},
          tempStore,
          catalog: capacityCatalog,
          getNamespace: async () => NAMESPACE_ID,
          datasetLimits: { ...DATASET_LIMITS, max_canonical_bytes: 1 },
          jsonlLimits: JSONL_LIMITS,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'resource_limit' })
      expect(capacityCatalog.insertOrReadIdentityClaim).not.toHaveBeenCalled()
      expect(await draftTempFiles(tempRoot)).toEqual([])

      const conflictCatalog = new ClaimCatalog()
      const firstLine = raw.subarray(0, raw.indexOf(0x0a))
      const first = await materialize(firstLine, tempStore, conflictCatalog)
      await collectBytes(first.bytes)
      const changed = new TextEncoder().encode(
        new TextDecoder().decode(firstLine).replace('What is 2 + 2?', 'What is 3 + 3?'),
      )
      await expect(materialize(changed, tempStore, conflictCatalog)).rejects.toMatchObject({
        code: 'identity_conflict',
        detail: { reason: 'claim_request_mismatch' },
      })
      expect(await draftTempFiles(tempRoot)).toEqual([])
    })
  })
})

class ClaimCatalog implements V2IdentityAllocatorCatalog {
  readonly claims: CatalogIdentityClaimRowV2[] = []
  failAtCall: number | undefined

  readonly insertOrReadIdentityClaim = vi.fn(
    async (input: CatalogIdentityClaimInputV2): Promise<CatalogIdentityClaimResultV2> => {
      if (this.failAtCall === this.insertOrReadIdentityClaim.mock.calls.length) {
        throw new Error('claim failed')
      }
      const byClaim = this.claims.find((claim) => claim.claimKeyDigest === input.claimKeyDigest)
      if (byClaim !== undefined) return { status: 'existing_claim', row: byClaim }
      const byEntity = this.claims.find((claim) => claim.entityId === input.entityId)
      if (byEntity !== undefined) return { status: 'existing_entity', row: byEntity }
      const row = { ...input, createdAt: NOW }
      this.claims.push(row)
      return { status: 'created', row }
    },
  )
}

async function materialize(
  raw: Uint8Array,
  tempStore: V2TempStore,
  catalog: ClaimCatalog,
  options: { readonly expectedInputDigest?: string } = {},
) {
  return await materializeCanonicalDraftJsonlV1({
    source: chunkedSource(raw),
    options,
    tempStore,
    catalog,
    getNamespace: async () => NAMESPACE_ID,
    datasetLimits: DATASET_LIMITS,
    jsonlLimits: JSONL_LIMITS,
    signal: new AbortController().signal,
  })
}

function projectPlan(plan: Readonly<V2CanonicalDraftRecordIdentityPlan>): VectorRow {
  return {
    data_row_index: plan.dataRowIndex,
    generation_run_id: plan.generationRunId,
    event_keys: plan.claims.flatMap(({ request }) =>
      request.creation_profile === 'signal-event-v1' ||
      request.creation_profile === 'preference-event-v1'
        ? [request.seed.producer_event_key]
        : [],
    ),
    root_initial_record_jcs: canonicalJsonV2(plan.claims[0]?.request.initial_record),
    candidate_initial_jcs: plan.claims.flatMap(({ request }) =>
      request.creation_profile === 'candidate-v1'
        ? [canonicalJsonV2(request.initial_candidate)]
        : [],
    ),
    record_digest: createRecordRevisionV2(plan.record).record_digest,
    claims: plan.claims.map(({ prepared }) => projectClaim(prepared)),
  }
}

function projectClaim(claim: {
  readonly creation_profile: string
  readonly entity_kind: string
  readonly entity_id: string
  readonly claim_key_digest: string
  readonly request_digest: string
}): VectorClaim {
  return {
    creation_profile: claim.creation_profile,
    entity_kind: claim.entity_kind,
    entity_id: claim.entity_id,
    claim_key_digest: claim.claim_key_digest,
    request_digest: claim.request_digest,
  }
}

function projectCatalogClaim(claim: CatalogIdentityClaimRowV2): VectorClaim {
  return {
    creation_profile: claim.creationProfile,
    entity_kind: claim.entityKind,
    entity_id: claim.entityId,
    claim_key_digest: claim.claimKeyDigest,
    request_digest: claim.requestDigest,
  }
}

async function readVector(name: 'sft' | 'dpo' | 'rlvr'): Promise<CanonicalDraftVector> {
  return JSON.parse(
    new TextDecoder().decode(await readFixture(`canonical-draft-${name}-v1.expected.json`)),
  ) as CanonicalDraftVector
}

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./golden/fixtures/v2/${name}`, import.meta.url)))
}

async function withTempStore(
  run: (tempStore: V2TempStore, tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'databench-v2-draft-test-'))
  try {
    await run(new V2TempStore({ tempRoot, safetyMarginBytes: 0 }), tempRoot)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function draftTempFiles(tempRoot: string): Promise<string[]> {
  return (await readdir(tempRoot)).filter((name) => name.includes('-draft-')).sort()
}

async function* byteSource(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes
}

async function* chunkedSource(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 37) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 37))
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks = await collect(source)
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}
