import { readFileSync } from 'node:fs'
import {
  type DeleteRefResultV2 as CatalogDeleteRefResultV2,
  type CatalogIdentityClaimInputV2,
  type CatalogIdentityClaimResultV2,
  type CatalogIdentityClaimRowV2,
  type CatalogLayoutRowV2,
  type CatalogRefPageV2,
  type CatalogRefRowV2,
  type RestoreRefResultV2 as CatalogRestoreRefResultV2,
  type CatalogRunPageV2,
  type CatalogRunRowV2,
  type CatalogSnapshotRowV2,
  type CompareAndSetRefV2,
  type DeleteRefV2,
  type RegisterLayoutV2,
  type RegisterTransformResultV2,
  type RestoreRefV2,
  V2Catalog,
  V2CatalogDeterminismConflictError,
  V2CatalogRefConflictError,
  V2CatalogRefStateConflictError,
  V2CatalogTargetNotCommittedError,
} from '@databench/catalog'
import { DEFAULT_V2_DATASET_LIMITS, V2Dataset, type V2DatasetLimits } from '@databench/engine'
import { createDefaultV2ConverterRegistry, type V2ConverterRegistry } from '@databench/io'
import {
  AppendEvidenceV2ParamsSchema,
  defineV2Transform,
  V2TransformRegistry,
} from '@databench/ops'
import {
  CapacityExceededError,
  createDatasetManifestV2,
  type DatasetLayoutIdentityV2,
  type DatasetManifestV2,
  IntegrityError,
  NotFoundError,
  type PostTrainingRecordV2,
  RefConflictErrorV2,
  V2_LINEAGE_CURSOR_MAX_CHARS,
} from '@databench/schema'
import type {
  PreparedArtifactV2,
  AuditResultV2 as StoreAuditResultV2,
  V2OperationContext,
  V2Store,
} from '@databench/store'
import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_V2_CACHE_MAX_PENDING_LOADS,
  DEFAULT_V2_CURSOR_TTL_MS,
  postTrainingV2Capability,
  registrationFromCommittedDataset,
  V2DatasetCache,
  type V2TransformLimits,
  V2Workspace,
  type V2WorkspaceCatalog,
  v2DatasetCacheRequiredWeight,
  v2DatasetCacheWeight,
  v2WorkspaceTempRoot,
} from '../src/v2/index.js'

const CURSOR_SECRET = '0123456789abcdef-v2-workspace-secret'
const NAMESPACE_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-07-23T12:00:00.000Z')

interface WorkspaceV2Fixture {
  readonly fixture_version: 1
  readonly publish_order: readonly ['prepare', 'commit', 'register', 'namespace', 'cas', 'discard']
  readonly cache_key_fields: readonly ['dataset_version', 'layout_version', 'artifact_digest']
  readonly cache_record_overhead_bytes: 256
  readonly cache_max_pending_loads: 64
  readonly cursor_ttl_ms: 900000
  readonly ref_conflict_preserves_committed_dataset: true
}

interface TransformV2Fixture {
  readonly fixture_version: 1
  readonly identity_profile: 'databench-v2-jcs-1'
  readonly operations: readonly {
    readonly name: string
    readonly version: '1'
    readonly input_roles: readonly string[]
    readonly params: Readonly<Record<string, unknown>>
    readonly identity_mode: 'preserve' | 'derive'
  }[]
  readonly cache: {
    readonly operation: 'subset'
    readonly input_dataset_versions: readonly [string]
    readonly normalized_params: { readonly record_ids: readonly [string] }
    readonly cache_key: string
    readonly run_id: string
    readonly output_dataset_version: string
    readonly first_run_cache_hit: false
    readonly retry_cache_hit: true
  }
  readonly prompt_rewrite: {
    readonly input_dataset_versions: readonly [string, string]
    readonly cache_key: string
    readonly run_id: string
    readonly parent_record_id: string
    readonly parent_record_digest: string
    readonly derived_record_id: string
    readonly derived_record_digest: string
    readonly output_dataset_version: string
    readonly output_index: 0
    readonly parent_count: 1
  }
  readonly lineage: {
    readonly traversal: 'breadth-first'
    readonly producing_run_order: 'cache_key_ascii'
    readonly run_input_order: 'position'
    readonly root_depth: 0
    readonly root_dataset_version: string
    readonly input_dataset_versions: readonly [string, string]
    readonly request: { readonly max_depth: number; readonly max_nodes: number }
    readonly page_node_versions: readonly [readonly [string], readonly [string], readonly [string]]
    readonly cursor_strategy: 'snapshot-replay'
    readonly cursor_max_chars: 1536
    readonly cursor_bindings: readonly string[]
    readonly reject_at_or_after_ttl: true
  }
  readonly race: {
    readonly same_cache_key: {
      readonly result: 'idempotent'
      readonly run_id: string
      readonly output_dataset_version: string
    }
    readonly different_output: {
      readonly result: 'determinism_conflict'
      readonly error_code: 'determinism_conflict'
      readonly attempted_dataset_committed: true
      readonly ref_moved: false
    }
  }
  readonly capacity: {
    readonly working_set_budget_bytes: 0
    readonly error_code: 'capacity_exceeded'
    readonly resource: 'working_set_bytes'
    readonly cache_lookup_attempted: false
    readonly prepare_attempted: false
  }
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./golden/fixtures/v2/workspace-publish-read-cache-ref.fixture.json', import.meta.url),
    'utf8',
  ),
) as WorkspaceV2Fixture

const transformFixture = JSON.parse(
  readFileSync(
    new URL('./golden/fixtures/v2/transform-identity-cache-race.fixture.json', import.meta.url),
    'utf8',
  ),
) as TransformV2Fixture

test('locks the V9 cache/cursor golden policy', () => {
  const dataset = makeDataset('f', 'golden policy')
  expect(fixture.fixture_version).toBe(1)
  expect(fixture.cache_key_fields).toEqual(['dataset_version', 'layout_version', 'artifact_digest'])
  expect(v2DatasetCacheWeight(dataset) - dataset.canonicalBytes).toBe(
    fixture.cache_record_overhead_bytes * dataset.length,
  )
  expect(DEFAULT_V2_CURSOR_TTL_MS).toBe(fixture.cursor_ttl_ms)
  expect(DEFAULT_V2_CACHE_MAX_PENDING_LOADS).toBe(fixture.cache_max_pending_loads)
})

test('locks the V10 transform, lineage, race, and capacity golden policy', () => {
  expect(transformFixture.fixture_version).toBe(1)
  expect(transformFixture.identity_profile).toBe('databench-v2-jcs-1')
  expect(transformFixture.lineage).toMatchObject({
    traversal: 'breadth-first',
    producing_run_order: 'cache_key_ascii',
    run_input_order: 'position',
    root_depth: 0,
    cursor_strategy: 'snapshot-replay',
    cursor_max_chars: V2_LINEAGE_CURSOR_MAX_CHARS,
    cursor_bindings: [
      'namespace_id',
      'requested_ref',
      'root_dataset_version',
      'snapshot_sequence',
      'max_depth',
      'max_nodes',
      'emitted_nodes',
      'emitted_edges',
    ],
    reject_at_or_after_ttl: true,
  })
  expect(transformFixture.race).toMatchObject({
    same_cache_key: { result: 'idempotent' },
    different_output: {
      result: 'determinism_conflict',
      attempted_dataset_committed: true,
      ref_moved: false,
    },
  })
})

describe('V2Workspace publish orchestration', () => {
  test('streams canonical JSONL through the same publish path', async () => {
    const rig = createRig()
    const record = makeRecord('0', 'JSONL publish')
    const expected = V2Dataset.fromRecords([record])
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)

    const result = await rig.workspace.addJsonl(
      (async function* (): AsyncIterable<Uint8Array> {
        yield bytes.subarray(0, 7)
        yield bytes.subarray(7)
      })(),
      noRef(),
    )

    expect(result.dataset_version).toBe(expected.version)
    expect(rig.events).toEqual(['prepare', 'commit', 'register', 'discard'])
  })

  test('consumes the file part before awaiting asynchronous multipart options', async () => {
    const rig = createRig()
    const record = makeRecord('0', 'field-order independent multipart')
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)
    const options = deferred<ReturnType<typeof noRef>>()
    let sourceStarted = false
    const source = (async function* (): AsyncIterable<Uint8Array> {
      sourceStarted = true
      yield bytes
    })()

    const pending = rig.workspace.addJsonl(source, options.promise)
    await eventually(() => expect(sourceStarted).toBe(true))
    expect(rig.store.prepare).not.toHaveBeenCalled()
    options.resolve(noRef())

    await expect(pending).resolves.toMatchObject({
      dataset_version: V2Dataset.fromRecords([record]).version,
    })
    expect(rig.events).toEqual(['prepare', 'commit', 'register', 'discard'])
  })

  test('closes the JSONL source and preserves an asynchronous options failure', async () => {
    const rig = createRig()
    const record = makeRecord('0', 'invalid trailing multipart field')
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)
    const options = deferred<ReturnType<typeof noRef>>()
    const failure = new Error('multipart options invalid')
    let sourceClosed = false
    const source = (async function* (): AsyncIterable<Uint8Array> {
      try {
        yield bytes
        options.reject(failure)
        yield bytes
      } finally {
        sourceClosed = true
      }
    })()

    await expect(rig.workspace.addJsonl(source, options.promise)).rejects.toBe(failure)
    expect(sourceClosed).toBe(true)
    expect(rig.store.prepare).not.toHaveBeenCalled()
  })

  test('cancels while waiting for trailing multipart options after closing the file source', async () => {
    const rig = createRig()
    const record = makeRecord('0', 'cancel trailing multipart fields')
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)
    const options = deferred<ReturnType<typeof noRef>>()
    const controller = new AbortController()
    const cancelled = new Error('request cancelled')
    let sourceClosed = false
    const source = (async function* (): AsyncIterable<Uint8Array> {
      try {
        yield bytes
      } finally {
        sourceClosed = true
      }
    })()

    const pending = rig.workspace.addJsonl(source, options.promise, {
      signal: controller.signal,
    })
    await eventually(() => expect(sourceClosed).toBe(true))
    controller.abort(cancelled)

    await expect(pending).rejects.toBe(cancelled)
    expect(rig.store.prepare).not.toHaveBeenCalled()
  })

  test('publishes in the fixed prepare/commit/register/CAS/discard order', async () => {
    const rig = createRig()
    const record = makeRecord('1', 'ordered publish')

    const result = await rig.workspace.addRecords([record], {
      ref: 'main',
      expected_ref_version: null,
      message: 'first publish',
    })

    expect(rig.events).toEqual(fixture.publish_order)
    expect(result).toMatchObject({
      dataset_version: rig.store.preparedDatasets[0]?.version,
      ref_update: {
        status: 'updated',
        ref_name: 'main',
        previous_version: null,
        current_version: rig.store.preparedDatasets[0]?.version,
      },
    })
    expect(rig.catalog.registrations).toHaveLength(1)
    expect(rig.store.discardContexts).toEqual([{}])
  })

  test('stops at prepare failure without attempting cleanup or later stages', async () => {
    const rig = createRig()
    const primary = new Error('prepare failed')
    rig.store.failures.prepare = primary

    await expect(
      rig.workspace.addRecords([makeRecord('2', 'prepare failure')], noRef()),
    ).rejects.toBe(primary)
    expect(rig.events).toEqual(['prepare'])
  })

  test('discards after commit failure without inheriting an aborted signal or masking primary', async () => {
    const rig = createRig()
    const controller = new AbortController()
    const primary = new Error('commit failed')
    rig.store.failures.commit = primary
    rig.store.failures.discard = new Error('discard also failed')
    rig.store.beforeCommit = () => controller.abort(new Error('request aborted during commit'))

    await expect(
      rig.workspace.addRecords([makeRecord('3', 'commit failure')], noRef(), {
        signal: controller.signal,
      }),
    ).rejects.toBe(primary)
    expect(rig.events).toEqual(['prepare', 'commit', 'discard', 'discard'])
    expect(rig.store.discardContexts).toEqual([{}, {}])
    expect((primary as Error & { suppressed: unknown[] }).suppressed).toEqual([
      rig.store.failures.discard,
    ])
    expect(rig.cleanupErrors).toEqual([
      { error: rig.store.failures.discard, primaryError: primary },
    ])
  })

  test('discards a committed artifact after catalog registration failure and never attempts CAS', async () => {
    const rig = createRig()
    const primary = new Error('register failed')
    rig.catalog.failures.register = primary

    const publish = rig.workspace.addRecords([makeRecord('4', 'register failure')], {
      ref: 'main',
      expected_ref_version: null,
      message: 'must not move',
    })
    await expect(publish).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      code: 'service_unavailable',
      detail: { dependency: 'catalog' },
      cause: primary,
    })
    expect(rig.events).toEqual(['prepare', 'commit', 'register', 'discard'])
    expect(rig.catalog.compareAndSetRef).not.toHaveBeenCalled()
  })

  test('keeps an invalid committed manifest classified as integrity, not Catalog unavailability', async () => {
    const rig = createRig()
    const record = makeRecord('e', 'manifest mismatch')
    const dataset = V2Dataset.fromRecords([record])
    rig.store.commitManifest = createDatasetManifestV2({
      ...dataset.identity,
      dataset_version: '1'.repeat(64),
      layout_version: 'record-json-v1',
      artifact_digest: '2'.repeat(64),
      artifact_size_bytes: 1,
    })

    await expect(rig.workspace.addRecords([record], noRef())).rejects.toMatchObject({
      name: 'IntegrityError',
      code: 'integrity_error',
    })
    expect(rig.catalog.registerCommittedLayout).not.toHaveBeenCalled()
  })

  test('does not turn a successful ref move into failure when bounded cleanup retries fail', async () => {
    const rig = createRig()
    const cleanup = new Error('persistent cleanup failure')
    rig.store.failures.discard = cleanup

    await expect(
      rig.workspace.addRecords([makeRecord('a', 'successful publish')], {
        ref: 'main',
        expected_ref_version: null,
        message: 'published before cleanup',
      }),
    ).resolves.toMatchObject({ ref_update: { status: 'updated', ref_name: 'main' } })
    expect(rig.events).toEqual([
      'prepare',
      'commit',
      'register',
      'namespace',
      'cas',
      'discard',
      'discard',
    ])
    expect(rig.cleanupErrors).toEqual([{ error: cleanup, primaryError: null }])
  })

  test('reports a CAS conflict after preserving the newly committed exact dataset', async () => {
    const rig = createRig()
    const currentVersion = 'e'.repeat(64)
    const expectedVersion = 'd'.repeat(64)
    const record = makeRecord('5', 'CAS conflict')
    const expectedDataset = V2Dataset.fromRecords([record])
    rig.catalog.failures.cas = new V2CatalogRefConflictError({
      namespaceId: NAMESPACE_ID,
      refName: 'main',
      expectedVersion,
      currentVersion,
      newVersion: expectedDataset.version,
    })

    const publish = rig.workspace.addRecords([record], {
      ref: 'main',
      expected_ref_version: expectedVersion,
      message: 'conflicting move',
    })
    await expect(publish).rejects.toMatchObject({
      name: 'RefConflictErrorV2',
      code: 'ref_conflict',
      detail: {
        ref_name: 'main',
        expected_version: expectedVersion,
        current_version: currentVersion,
        new_version: expectedDataset.version,
        new_dataset_committed: true,
      },
    })
    await expect(publish).rejects.toBeInstanceOf(RefConflictErrorV2)
    expect(rig.events).toEqual(['prepare', 'commit', 'register', 'namespace', 'cas', 'discard'])

    rig.catalog.failures.cas = undefined
    rig.events.length = 0
    await expect(rig.workspace.get(expectedDataset.version)).resolves.toEqual(expectedDataset)
    expect(fixture.ref_conflict_preserves_committed_dataset).toBe(true)
    expect(rig.events).toEqual(['getSnapshot', 'getLayout', 'read'])
  })
})

describe('V2Workspace read, cache, and audit orchestration', () => {
  test('holds a cache pin for the complete withDataset consumer lifetime', async () => {
    const events: string[] = []
    const limits = { max_records: 1, max_canonical_bytes: 2048, max_record_bytes: 2048 }
    const store = new FakeStore(events, limits)
    const catalog = new FakeCatalog(events)
    const maxEntryWeight = 2304
    const cache = new V2DatasetCache({ capacityBytes: maxEntryWeight, maxEntryWeight })
    const workspace = new V2Workspace({
      catalog,
      store,
      cursorSecret: CURSOR_SECRET,
      cache,
      datasetLimits: limits,
    })
    const first = makeDataset('c', 'first pinned dataset')
    const second = makeDataset('d', 'second capacity contender')
    for (const dataset of [first, second]) {
      const registration = registrationFromCommittedDataset(dataset, store.seed(dataset))
      catalog.snapshots.set(dataset.version, { ...registration.snapshot, createdAt: NOW })
      catalog.layouts.set(dataset.version, { ...registration.layout, committedAt: NOW })
    }

    await workspace.withDataset(first.version, async (dataset, exactVersion) => {
      expect(dataset.version).toBe(first.version)
      expect(exactVersion).toBe(first.version)
      await expect(workspace.get(second.version)).rejects.toBeInstanceOf(CapacityExceededError)
    })
    await expect(workspace.get(second.version)).resolves.toEqual(second)
  })

  test('resolves a mutable ref exactly once before reading its immutable layout', async () => {
    const rig = createRig()
    const dataset = makeDataset('6', 'resolve once')
    rig.seed(dataset)
    rig.catalog.refs.set('main', refRow('main', dataset.version, 'current'))
    rig.events.length = 0

    await expect(rig.workspace.get('main')).resolves.toEqual(dataset)

    expect(rig.catalog.getRef).toHaveBeenCalledTimes(1)
    expect(rig.catalog.getSnapshot).toHaveBeenCalledWith(dataset.version)
    expect(rig.catalog.getLayout).toHaveBeenCalledWith(dataset.version, 'record-json-v1')
    expect(rig.events).toEqual(['namespace', 'getRef', 'getSnapshot', 'getLayout', 'read'])
  })

  test('reuses one verified Store read across record page and record view requests', async () => {
    const rig = createRig()
    const dataset = makeDataset('7', 'cache once')
    rig.seed(dataset)
    rig.events.length = 0
    const recordId = [...dataset.records()][0]?.record.id
    if (!recordId) throw new Error('fixture record is missing')

    const page = await rig.workspace.getRecordPage(dataset.version, { offset: 0, limit: 1 })
    const view = await rig.workspace.getRecordView(dataset.version, recordId)

    expect(page.items).toHaveLength(1)
    expect(view?.record.id).toBe(recordId)
    expect(rig.store.read).toHaveBeenCalledTimes(1)
    expect(rig.events.filter((event) => event === 'read')).toHaveLength(1)
  })

  test('maps missing registered Store data to integrity errors for read and describe', async () => {
    const rig = createRig()
    const dataset = makeDataset('8', 'missing objects')
    rig.seedCatalogOnly(dataset)

    await expect(rig.workspace.get(dataset.version)).rejects.toMatchObject({
      name: 'IntegrityError',
      code: 'integrity_error',
      detail: {
        reason: 'store_layout_missing',
        dataset_version: dataset.version,
        layout_version: 'record-json-v1',
      },
    })
    await expect(rig.workspace.describeDataset(dataset.version)).rejects.toMatchObject({
      name: 'IntegrityError',
      detail: { reason: 'manifest_missing', dataset_version: dataset.version },
    })
  })

  test('validates record IDs before Catalog or Store work and evicts a stale cache on describe', async () => {
    const rig = createRig()
    const dataset = makeDataset('b', 'describe eviction')
    rig.seed(dataset)
    await rig.workspace.get(dataset.version)
    const readsBeforeInvalidId = rig.store.read.mock.calls.length

    await expect(rig.workspace.getRecordView(dataset.version, 'invalid-id')).rejects.toBeDefined()
    expect(rig.store.read).toHaveBeenCalledTimes(readsBeforeInvalidId)

    rig.store.committed.delete(dataset.version)
    await expect(rig.workspace.describeDataset(dataset.version)).rejects.toBeInstanceOf(
      IntegrityError,
    )
    rig.store.seed(dataset)
    await rig.workspace.get(dataset.version)
    expect(rig.store.read).toHaveBeenCalledTimes(readsBeforeInvalidId + 1)
  })

  test('cancels read-only Catalog waits without waiting for a stuck database call', async () => {
    const rig = createRig()
    const controller = new AbortController()
    rig.catalog.getSnapshot.mockImplementationOnce(async () => await new Promise(() => {}))

    const read = rig.workspace.get('c'.repeat(64), { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(rig.store.read).not.toHaveBeenCalled()
  })

  test('audit bypasses cached reads and evicts the cached layout after an audit failure', async () => {
    const rig = createRig()
    const dataset = makeDataset('9', 'audit')
    rig.seed(dataset)
    rig.events.length = 0

    await rig.workspace.get(dataset.version)
    const audit = await rig.workspace.audit(dataset.version)
    expect(audit.checks).toEqual({
      manifest: 'ok',
      artifact_digest: 'ok',
      parquet_schema: 'ok',
      record_digests: 'ok',
      dataset_version: 'ok',
    })
    expect(rig.store.read).toHaveBeenCalledTimes(1)
    expect(rig.store.audit).toHaveBeenCalledTimes(1)

    rig.store.failures.audit = new NotFoundError('artifact disappeared')
    await expect(rig.workspace.audit(dataset.version)).rejects.toBeInstanceOf(IntegrityError)
    rig.store.failures.audit = undefined
    await rig.workspace.get(dataset.version)

    expect(rig.store.audit).toHaveBeenCalledTimes(2)
    expect(rig.store.read).toHaveBeenCalledTimes(2)
  })
})

describe('V2Workspace refs facade', () => {
  test('lists with opaque cursors and supports get/put through one cached namespace', async () => {
    const rig = createRig()
    const alphaVersion = 'a'.repeat(64)
    const betaVersion = 'b'.repeat(64)
    const gammaVersion = 'c'.repeat(64)
    rig.catalog.listPages.set(null, {
      rows: [refRow('a-', alphaVersion, null), refRow('a.', betaVersion, 'second')],
      nextName: 'a.',
    })
    rig.catalog.listPages.set('a.', {
      rows: [refRow('z-ref', gammaVersion, null)],
      nextName: null,
    })
    rig.catalog.refs.set('a-', refRow('a-', alphaVersion, null))

    const first = await rig.workspace.listRefs({ cursor: null, limit: 2 })
    expect(first.items.map(({ name }) => name)).toEqual(['a-', 'a.'])
    expect(first.next_cursor).toEqual(expect.any(String))

    const second = await rig.workspace.listRefs({ cursor: first.next_cursor, limit: 2 })
    expect(second).toEqual({
      items: [
        {
          name: 'z-ref',
          version: gammaVersion,
          num_records: 0,
          message: null,
          updated_at: NOW.toISOString(),
        },
      ],
      next_cursor: null,
    })
    await expect(rig.workspace.getRef('a-')).resolves.toMatchObject({
      name: 'a-',
      version: alphaVersion,
    })
    await expect(
      rig.workspace.putRef('release', {
        new_version: gammaVersion,
        expected_version: betaVersion,
        message: 'promote',
      }),
    ).resolves.toEqual({
      name: 'release',
      version: gammaVersion,
      num_records: 0,
      message: 'promote',
      updated_at: NOW.toISOString(),
    })

    expect(rig.catalog.listRefs).toHaveBeenNthCalledWith(1, NAMESPACE_ID, null, 2)
    expect(rig.catalog.listRefs).toHaveBeenNthCalledWith(2, NAMESPACE_ID, 'a.', 2)
    expect(rig.catalog.compareAndSetRef).toHaveBeenCalledWith({
      namespaceId: NAMESPACE_ID,
      name: 'release',
      newVersion: gammaVersion,
      expectedVersion: betaVersion,
      message: 'promote',
    })
    expect(rig.catalog.getOrCreateNamespace).toHaveBeenCalledTimes(1)
  })

  test('reports standalone ref CAS conflicts against an already committed target', async () => {
    const rig = createRig()
    const expectedVersion = 'd'.repeat(64)
    const currentVersion = 'e'.repeat(64)
    const newVersion = 'f'.repeat(64)
    rig.catalog.failures.cas = new V2CatalogRefConflictError({
      namespaceId: NAMESPACE_ID,
      refName: 'main',
      expectedVersion,
      currentVersion,
      newVersion,
    })

    await expect(
      rig.workspace.putRef('main', {
        new_version: newVersion,
        expected_version: expectedVersion,
        message: 'move',
      }),
    ).rejects.toMatchObject({
      name: 'RefConflictErrorV2',
      detail: { new_version: newVersion, new_dataset_committed: true },
    })
  })

  test('deletes refs with CAS, keeps retries idempotent, and maps concurrent moves', async () => {
    const rig = createRig()
    const expectedVersion = 'd'.repeat(64)
    const currentVersion = 'e'.repeat(64)
    rig.catalog.refs.set('main', refRow('main', expectedVersion, null))

    await expect(
      rig.workspace.deleteRef('main', { expected_version: expectedVersion }),
    ).resolves.toEqual({
      status: 'deleted',
      ref: {
        name: 'main',
        version: expectedVersion,
        num_records: 0,
        message: null,
        updated_at: NOW.toISOString(),
        deleted_at: NOW.toISOString(),
      },
    })
    await expect(rig.workspace.getRef('main')).resolves.toBeNull()
    await expect(rig.workspace.getDeletedRef('main')).resolves.toMatchObject({
      name: 'main',
      version: expectedVersion,
      deleted_at: NOW.toISOString(),
    })
    await expect(
      rig.workspace.deleteRef('main', { expected_version: expectedVersion }),
    ).resolves.toMatchObject({ status: 'already_deleted' })

    await expect(
      rig.workspace.restoreRef('main', { expected_version: expectedVersion }),
    ).resolves.toMatchObject({
      status: 'restored',
      ref: { name: 'main', version: expectedVersion },
    })
    await expect(rig.workspace.getDeletedRef('main')).resolves.toBeNull()
    await expect(rig.workspace.getRef('main')).resolves.toMatchObject({
      name: 'main',
      version: expectedVersion,
    })
    await expect(
      rig.workspace.restoreRef('main', { expected_version: expectedVersion }),
    ).resolves.toMatchObject({ status: 'already_active' })

    rig.catalog.refs.set('main', refRow('main', currentVersion, null))
    rig.catalog.failures.delete = new V2CatalogRefStateConflictError({
      namespaceId: NAMESPACE_ID,
      refName: 'main',
      expectedVersion,
      currentVersion,
      currentState: 'active',
      operation: 'delete',
    })
    await expect(
      rig.workspace.deleteRef('main', { expected_version: expectedVersion }),
    ).rejects.toMatchObject({
      name: 'RefStateConflictErrorV2',
      code: 'ref_state_conflict',
      detail: {
        ref_name: 'main',
        expected_version: expectedVersion,
        current_version: currentVersion,
        current_state: 'active',
        operation: 'delete',
      },
    })
  })

  test('paginates deleted refs separately and rejects cursors from the active view', async () => {
    const rig = createRig()
    const activeVersion = 'a'.repeat(64)
    const deletedVersion = 'b'.repeat(64)
    rig.catalog.listPages.set(null, {
      rows: [refRow('active', activeVersion, null)],
      nextName: 'active',
    })
    rig.catalog.deletedListPages.set(null, {
      rows: [refRow('deleted', deletedVersion, 'removed', NOW)],
      nextName: 'deleted',
    })

    const activePage = await rig.workspace.listRefs({ cursor: null, limit: 1 })
    const deletedPage = await rig.workspace.listDeletedRefs({ cursor: null, limit: 1 })
    expect(deletedPage.items).toEqual([
      {
        name: 'deleted',
        version: deletedVersion,
        num_records: 0,
        message: 'removed',
        updated_at: NOW.toISOString(),
        deleted_at: NOW.toISOString(),
      },
    ])
    await expect(
      rig.workspace.listDeletedRefs({ cursor: activePage.next_cursor, limit: 1 }),
    ).rejects.toMatchObject({ name: 'ValidationError' })
    await expect(
      rig.workspace.listRefs({ cursor: deletedPage.next_cursor, limit: 1 }),
    ).rejects.toMatchObject({ name: 'ValidationError' })
  })

  test('reports a missing standalone ref target as not found', async () => {
    const rig = createRig()
    const missingVersion = '7'.repeat(64)
    rig.catalog.failures.cas = new V2CatalogTargetNotCommittedError(missingVersion)

    await expect(
      rig.workspace.putRef('main', {
        new_version: missingVersion,
        expected_version: null,
        message: null,
      }),
    ).rejects.toMatchObject({ name: 'NotFoundError', code: 'not_found' })
  })

  test('rejects malformed Catalog ref pages as integrity failures', async () => {
    const rig = createRig()
    rig.catalog.listPages.set(null, {
      rows: [refRow('z-ref', 'a'.repeat(64), null), refRow('a-ref', 'b'.repeat(64), null)],
      nextName: 'a-ref',
    })

    await expect(rig.workspace.listRefs({ cursor: null, limit: 2 })).rejects.toMatchObject({
      name: 'IntegrityError',
      detail: { reason: 'catalog_ref_page_order' },
    })
  })
})

describe('V2Workspace transform and dataset lineage', () => {
  test('lists the stable built-in registry and reuses a fully verified run cache hit', async () => {
    const rig = createRig()
    const input = makeDataset('1', 'subset cache')
    rig.seed(input)

    expect(
      rig.workspace.listTransforms().map(({ name, version, identity_mode }) => ({
        name,
        version,
        identity_mode,
      })),
    ).toEqual(
      transformFixture.operations.map(({ name, version, identity_mode }) => ({
        name,
        version,
        identity_mode,
      })),
    )
    expect(input.version).toBe(transformFixture.cache.input_dataset_versions[0])
    const request = {
      inputs: [input.version],
      params: transformFixture.cache.normalized_params,
      ...noRef(),
    }
    const first = await rig.workspace.runTransform('subset', request)
    expect(first).toMatchObject({
      cache_hit: transformFixture.cache.first_run_cache_hit,
      run: {
        cache_key: transformFixture.cache.cache_key,
        run_id: transformFixture.cache.run_id,
        input_dataset_versions: transformFixture.cache.input_dataset_versions,
        normalized_params: transformFixture.cache.normalized_params,
        output_dataset_version: transformFixture.cache.output_dataset_version,
        created_at: NOW.toISOString(),
      },
    })
    const prepares = rig.store.prepare.mock.calls.length

    const second = await rig.workspace.runTransform('subset', request)
    expect(second).toEqual({ ...first, cache_hit: transformFixture.cache.retry_cache_hit })
    expect(second.run).toMatchObject({
      run_id: transformFixture.race.same_cache_key.run_id,
      output_dataset_version: transformFixture.race.same_cache_key.output_dataset_version,
    })
    expect(rig.store.prepare).toHaveBeenCalledTimes(prepares)
    expect(rig.catalog.registerTransformResult).toHaveBeenCalledTimes(1)
  })

  test('derives prompt-only records with a stable claim and exact parent revision', async () => {
    const rig = createRig()
    const parent = makeDataset('2', 'old prompt')
    const rewrite = makeDataset('2', 'new prompt')
    rig.seed(parent)
    rig.seed(rewrite)
    expect([parent.version, rewrite.version]).toEqual(
      transformFixture.prompt_rewrite.input_dataset_versions,
    )

    const result = await rig.workspace.runTransform('prompt-rewrite', {
      inputs: [parent.version, rewrite.version],
      params: {},
      ...noRef(),
    })
    const output = await rig.workspace.get(result.run.output_dataset_version)
    const revision = [...output.records()][0]
    const parentRevision = [...parent.records()][0]
    expect(revision).toBeDefined()
    expect(parentRevision).toBeDefined()
    expect(result.run).toMatchObject({
      cache_key: transformFixture.prompt_rewrite.cache_key,
      run_id: transformFixture.prompt_rewrite.run_id,
      output_dataset_version: transformFixture.prompt_rewrite.output_dataset_version,
    })
    expect(output.version).toBe(transformFixture.prompt_rewrite.output_dataset_version)
    expect(parentRevision).toMatchObject({
      record: { id: transformFixture.prompt_rewrite.parent_record_id },
      record_digest: transformFixture.prompt_rewrite.parent_record_digest,
    })
    expect(revision).toMatchObject({
      record: { id: transformFixture.prompt_rewrite.derived_record_id },
      record_digest: transformFixture.prompt_rewrite.derived_record_digest,
    })
    expect(revision?.record.contents).toEqual([...rewrite.records()][0]?.record.contents)
    expect(revision?.record.lineage).toMatchObject({
      parent_refs: [
        { id: parentRevision?.record.id, record_digest: parentRevision?.record_digest },
      ],
      run_id: result.run.run_id,
      steps: [{ name: 'prompt-rewrite', version: '1', params: {} }],
    })
    expect(rig.catalog.insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)

    const retry = await rig.workspace.runTransform('prompt-rewrite', {
      inputs: [parent.version, rewrite.version],
      params: {},
      ...noRef(),
    })
    expect(retry.run.output_dataset_version).toBe(output.version)
    expect(retry.cache_hit).toBe(true)
    expect(rig.catalog.insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)
  })

  test('paginates BFS lineage with ordered exact run inputs and a scoped cursor', async () => {
    const rig = createRig()
    const parent = makeDataset('2', 'old prompt')
    const rewrite = makeDataset('2', 'new prompt')
    rig.seed(parent)
    rig.seed(rewrite)
    const transformed = await rig.workspace.runTransform('prompt-rewrite', {
      inputs: [parent.version, rewrite.version],
      params: {},
      ...noRef(),
    })

    const first = await rig.workspace.lineage(transformed.run.output_dataset_version, {
      ...transformFixture.lineage.request,
      cursor: null,
    })
    expect(first.root_dataset_version).toBe(transformFixture.lineage.root_dataset_version)
    expect(first.nodes.map(({ dataset_version }) => dataset_version)).toEqual(
      transformFixture.lineage.page_node_versions[0],
    )
    expect(first.edges).toEqual([
      {
        run_id: transformFixture.prompt_rewrite.run_id,
        input_dataset_versions: transformFixture.lineage.input_dataset_versions,
        output_dataset_version: transformFixture.lineage.root_dataset_version,
      },
    ])
    expect(first.truncated).toBe(true)
    expect(first.next_cursor).toEqual(expect.any(String))

    const snapshotSequence = rig.catalog.runs.get(transformed.run.cache_key)?.lineageSequence
    if (snapshotSequence === undefined) throw new Error('transform run sequence was not retained')
    const lateCacheKey = 'f'.repeat(64)
    const lateRunId = `run_${lateCacheKey}`
    rig.catalog.runs.set(lateCacheKey, {
      id: lateRunId,
      cacheKey: lateCacheKey,
      lineageSequence: snapshotSequence + 1n,
      op: 'prompt-rewrite',
      opVersion: '1',
      params: {},
      inputVersions: [parent.version, rewrite.version],
      outputVersion: transformed.run.output_dataset_version,
      createdAt: new Date(NOW.getTime() + 1),
    })

    const second = await rig.workspace.lineage(transformed.run.output_dataset_version, {
      ...transformFixture.lineage.request,
      cursor: first.next_cursor,
    })
    expect(second.nodes.map(({ dataset_version }) => dataset_version)).toEqual(
      transformFixture.lineage.page_node_versions[1],
    )
    expect(second.truncated).toBe(true)
    expect(second.next_cursor).toEqual(expect.any(String))

    const third = await rig.workspace.lineage(transformed.run.output_dataset_version, {
      ...transformFixture.lineage.request,
      cursor: second.next_cursor,
    })
    expect(third.nodes.map(({ dataset_version }) => dataset_version)).toEqual(
      transformFixture.lineage.page_node_versions[2],
    )
    expect(third).toMatchObject({ truncated: false, next_cursor: null })
    expect([...second.edges, ...third.edges].map(({ run_id }) => run_id)).not.toContain(lateRunId)
    expect(rig.catalog.listRunsProducing.mock.calls).toSatisfy((calls) =>
      calls.every(([, , , cutoff]) => cutoff === snapshotSequence),
    )

    await expect(
      rig.workspace.lineage(parent.version, {
        ...transformFixture.lineage.request,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })

  test('rejects working-set overcommit before execution', async () => {
    const rig = createRig({
      max_working_set_bytes: transformFixture.capacity.working_set_budget_bytes,
    })
    const input = makeDataset('4', 'capacity')
    rig.seed(input)

    await expect(
      rig.workspace.runTransform('subset', {
        inputs: [input.version],
        params: { record_ids: [[...input.records()][0]?.record.id] },
        ...noRef(),
      }),
    ).rejects.toMatchObject({
      code: transformFixture.capacity.error_code,
      detail: { resource: transformFixture.capacity.resource },
    })
    expect(transformFixture.capacity.cache_lookup_attempted).toBe(false)
    expect(rig.catalog.findRun).not.toHaveBeenCalled()
    expect(transformFixture.capacity.prepare_attempted).toBe(false)
    expect(rig.store.prepare).not.toHaveBeenCalled()
  })

  test('fails closed when a custom transform underestimates its output', async () => {
    const definition = defineV2Transform({
      name: 'underestimated-output',
      version: '1',
      inputRoles: ['base'],
      paramsSchema: AppendEvidenceV2ParamsSchema,
      paramsExample: {},
      identityMode: 'preserve',
      rngSeed: () => null,
      estimateWorkingSet: () => ({ outputUpperBoundBytes: 0, frameEstimateBytes: 0 }),
      async run(inputs) {
        const input = inputs[0]
        if (!input) throw new TypeError('missing test input')
        return input
      },
    })
    const rig = createRig({}, new V2TransformRegistry([definition]))
    const input = makeDataset('5', 'underestimated output')
    rig.seed(input)

    await expect(
      rig.workspace.runTransform('underestimated-output', {
        inputs: [input.version],
        params: {},
        ...noRef(),
      }),
    ).rejects.toMatchObject({
      code: 'integrity_error',
      detail: {
        reason: 'transform_output_exceeds_estimate',
        declared_bytes: 0,
        actual_bytes: input.canonicalBytes,
      },
    })
    expect(rig.store.prepare).not.toHaveBeenCalled()
  })

  test('reports a committed determinism loser and never moves its requested ref', async () => {
    const rig = createRig()
    const input = makeDataset('5', 'determinism')
    rig.seed(input)
    rig.catalog.transformConflictOutput = 'f'.repeat(64)

    await expect(
      rig.workspace.runTransform('subset', {
        inputs: [input.version],
        params: { record_ids: [[...input.records()][0]?.record.id] },
        ref: 'main',
        expected_ref_version: null,
        message: 'must not move',
      }),
    ).rejects.toMatchObject({
      code: transformFixture.race.different_output.error_code,
      detail: {
        existing_output_version: 'f'.repeat(64),
        attempted_output_version: input.version,
        attempted_dataset_committed:
          transformFixture.race.different_output.attempted_dataset_committed,
      },
    })
    expect(transformFixture.race.different_output.ref_moved).toBe(false)
    expect(rig.catalog.compareAndSetRef).not.toHaveBeenCalled()
    expect(rig.store.committed.has(input.version)).toBe(true)
  })

  test('maps the read-after-determinism-conflict Catalog failure at the dependency boundary', async () => {
    const rig = createRig()
    const input = makeDataset('6', 'conflict read failure')
    rig.seed(input)
    rig.catalog.transformConflictOutput = 'e'.repeat(64)
    rig.catalog.findRun
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('database connection dropped'))

    await expect(
      rig.workspace.runTransform('subset', {
        inputs: [input.version],
        params: { record_ids: [[...input.records()][0]?.record.id] },
        ...noRef(),
      }),
    ).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      code: 'service_unavailable',
      detail: { dependency: 'catalog' },
    })
  })

  test('treats a Catalog conflict for an identical winning run as integrity corruption', async () => {
    const rig = createRig()
    const input = makeDataset('7', 'identical conflict')
    rig.seed(input)
    rig.catalog.transformConflictOutput = input.version

    await expect(
      rig.workspace.runTransform('subset', {
        inputs: [input.version],
        params: { record_ids: [[...input.records()][0]?.record.id] },
        ...noRef(),
      }),
    ).rejects.toMatchObject({
      code: 'integrity_error',
      detail: { reason: 'transform_conflict_for_identical_run' },
    })
  })

  test('keeps the transform slot until an aborted non-cooperative Catalog lookup settles', async () => {
    const rig = createRig({ max_concurrent_runs: 1, max_pending_runs: 1 })
    const input = makeDataset('8', 'catalog cancellation')
    rig.seed(input)
    const lookup = deferred<CatalogRunRowV2 | null>()
    rig.catalog.findRun.mockImplementationOnce(async () => await lookup.promise)
    const request = {
      inputs: [input.version],
      params: { record_ids: [[...input.records()][0]?.record.id] },
      ...noRef(),
    }
    const controller = new AbortController()
    const first = rig.workspace.runTransform('subset', request, { signal: controller.signal })
    await eventually(() => expect(rig.catalog.findRun).toHaveBeenCalledTimes(1))

    controller.abort(new DOMException('cancel first transform', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = rig.workspace.runTransform('subset', request)
    await Promise.resolve()
    expect(rig.catalog.findRun).toHaveBeenCalledTimes(1)
    expect(rig.store.prepare).not.toHaveBeenCalled()

    lookup.resolve(null)
    await expect(second).resolves.toMatchObject({ cache_hit: false })
    expect(rig.store.prepare).toHaveBeenCalledTimes(1)
  })

  test('keeps the transform slot until an aborted cache-hit output read settles', async () => {
    const rig = createRig({ max_concurrent_runs: 1, max_pending_runs: 1 })
    const parent = makeDataset('9', 'old prompt cancellation')
    const rewrite = makeDataset('9', 'new prompt cancellation')
    rig.seed(parent)
    rig.seed(rewrite)
    const request = {
      inputs: [parent.version, rewrite.version],
      params: {},
      ...noRef(),
    }
    const initial = await rig.workspace.runTransform('prompt-rewrite', request)
    const outputRead = deferred<void>()
    rig.store.readGates.set(initial.run.output_dataset_version, outputRead.promise)
    const controller = new AbortController()
    const readsBeforeHit = rig.store.read.mock.calls.length
    const hit = rig.workspace.runTransform('prompt-rewrite', request, {
      signal: controller.signal,
    })
    await eventually(() => expect(rig.store.read.mock.calls.length).toBe(readsBeforeHit + 1))

    controller.abort(new DOMException('cancel cached output read', 'AbortError'))
    await expect(hit).rejects.toMatchObject({ name: 'AbortError' })
    const findCallsWhileReadIsRunning = rig.catalog.findRun.mock.calls.length
    const retry = rig.workspace.runTransform('prompt-rewrite', request)
    await Promise.resolve()
    expect(rig.catalog.findRun).toHaveBeenCalledTimes(findCallsWhileReadIsRunning)

    outputRead.resolve()
    await expect(retry).resolves.toMatchObject({ cache_hit: true })
  })
})

describe('V2Workspace converter and fidelity orchestration', () => {
  test('inspects without opening a stream and resolves a ref only once', async () => {
    const registry = createDefaultV2ConverterRegistry()
    const stream = vi.spyOn(registry, 'stream')
    const rig = createRig({}, undefined, registry)
    const dataset = makeDataset('b', 'converter inspect')
    rig.seed(dataset)
    rig.catalog.refs.set('export-main', refRow('export-main', dataset.version, null))

    expect(rig.workspace.listConverters().map(({ name }) => name)).toEqual([
      'canonical-jsonl',
      'ms-swift',
      'trl-dpo',
      'trl-grpo-rlvr',
      'trl-sft',
    ])
    expect(rig.workspace.getConverter('canonical-jsonl')).toMatchObject({
      name: 'canonical-jsonl',
      export_fidelity_profile: 'databench-export-fidelity-1',
    })
    expect(rig.workspace.getConverter('unknown')).toBeNull()

    const plan = await rig.workspace.inspectExport('export-main', {
      converter: 'canonical-jsonl',
      options: {},
    })

    expect(plan).toMatchObject({
      dataset_version: dataset.version,
      converter: 'canonical-jsonl',
      converter_version: '1.0.0',
      normalized_options: {},
      output_count: 1,
      fidelity: { changes: [] },
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(rig.catalog.getRef).toHaveBeenCalledTimes(1)
    expect(stream).not.toHaveBeenCalled()
  })

  test('requires exact semantic approval before opening a trainer stream', async () => {
    const registry = createDefaultV2ConverterRegistry()
    const stream = vi.spyOn(registry, 'stream')
    const rig = createRig({}, undefined, registry)
    const dataset = V2Dataset.fromRecords([makeSelectedSftRecord('c')])
    rig.seed(dataset)
    const plan = await rig.workspace.inspectExport(dataset.version, {
      converter: 'trl-sft',
      options: {},
    })
    expect(plan.fidelity.changes).toContainEqual({
      path: '/contents',
      action: 'dropped',
      impact: 'semantic',
      reason: 'custom_loss_weight_not_representable',
    })

    await expect(
      rig.workspace.export(dataset.version, {
        converter: 'trl-sft',
        options: {},
        accepted_fidelity_digest: null,
      }),
    ).rejects.toMatchObject({
      name: 'FidelityErrorV2',
      code: 'fidelity_error',
      detail: {
        reason: 'semantic_loss_requires_approval',
        plan: { fidelity_digest: plan.fidelity_digest },
      },
    })
    expect(stream).not.toHaveBeenCalled()

    await expect(
      rig.workspace.export(dataset.version, {
        converter: 'trl-sft',
        options: {},
        accepted_fidelity_digest: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'fidelity_error',
      detail: { reason: 'fidelity_digest_mismatch' },
    })
    expect(stream).not.toHaveBeenCalled()
  })

  test('does not pin an unconsumed export and pins only for active byte iteration', async () => {
    const registry = createDefaultV2ConverterRegistry()
    const requiredWeight = v2DatasetCacheRequiredWeight(DEFAULT_V2_DATASET_LIMITS)
    const cache = new V2DatasetCache({
      capacityBytes: requiredWeight,
      maxEntryWeight: requiredWeight,
    })
    const rig = createRig({}, undefined, registry, cache)
    const dataset = makeDataset('d', 'lazy converter stream')
    rig.seed(dataset)
    const result = await rig.workspace.export(dataset.version, {
      converter: 'canonical-jsonl',
      options: {},
      accepted_fidelity_digest: null,
    })
    const key = {
      dataset_version: dataset.version,
      layout_version: 'record-json-v1',
      artifact_digest: artifactDigest(dataset.version),
    }

    expect(cache.evict(key)).toBe(true)
    const iterator = result.bytes[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('canonical export ended before its first row')
    const revision = [...dataset.records()][0]
    expect(new TextDecoder().decode(first.value)).toBe(`${revision?.record_json}\n`)
    expect(cache.evict(key)).toBe(false)
    await iterator.return?.()
    expect(cache.entryCount).toBe(0)
    expect(cache.usedBytes).toBe(0)
    expect(() => result.bytes[Symbol.asyncIterator]()).toThrowError(
      'V2 export byte stream can only be consumed once',
    )
  })

  test('releases an active stream pin on abort even when its iterator has no return', async () => {
    const requiredWeight = v2DatasetCacheRequiredWeight(DEFAULT_V2_DATASET_LIMITS)
    const cache = new V2DatasetCache({
      capacityBytes: requiredWeight,
      maxEntryWeight: requiredWeight,
    })
    const registry = createDefaultV2ConverterRegistry()
    vi.spyOn(registry, 'stream').mockReturnValue({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let emitted = false
        return {
          next: async () => {
            if (emitted) return await new Promise<IteratorResult<Uint8Array>>(() => undefined)
            emitted = true
            return { done: false, value: new TextEncoder().encode('first\n') }
          },
        }
      },
    })
    const rig = createRig({}, undefined, registry, cache)
    const dataset = makeDataset('e', 'aborted converter stream')
    rig.seed(dataset)
    const controller = new AbortController()
    const result = await rig.workspace.export(
      dataset.version,
      {
        converter: 'canonical-jsonl',
        options: {},
        accepted_fidelity_digest: null,
      },
      { signal: controller.signal },
    )
    const key = {
      dataset_version: dataset.version,
      layout_version: 'record-json-v1',
      artifact_digest: artifactDigest(dataset.version),
    }
    const iterator = result.bytes[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('canonical export ended before its first row')
    expect(cache.evict(key)).toBe(false)

    controller.abort(new DOMException('client disconnected', 'AbortError'))
    await eventually(() => expect(cache.usedBytes).toBe(0))
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('keeps the stream pin until a pending next without return settles after abort', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    let nextCalls = 0
    const controller = new AbortController()
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              return nextGate.promise
            },
          }
        },
      },
      'f',
      controller.signal,
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    controller.abort(new DOMException('client disconnected', 'AbortError'))
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)

    nextGate.resolve({ done: true, value: undefined })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('installs the pending-next fence before next can synchronously abort', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    let nextCalls = 0
    const controller = new AbortController()
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              controller.abort(new DOMException('synchronous disconnect', 'AbortError'))
              return nextGate.promise
            },
          }
        },
      },
      '6',
      controller.signal,
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)

    nextGate.resolve({ done: true, value: undefined })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('keeps the stream pin when abort return resolves before pending next', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    let nextCalls = 0
    const controller = new AbortController()
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              return nextGate.promise
            },
            return: close,
          }
        },
      },
      '7',
      controller.signal,
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    controller.abort(new DOMException('client disconnected', 'AbortError'))
    await eventually(() => expect(close).toHaveBeenCalledOnce())
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)

    nextGate.resolve({ done: true, value: undefined })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('preserves a pending next rejection when abort cleanup also fails', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    const primary = new Error('converter next failed')
    const cleanup = new Error('converter return failed')
    let nextCalls = 0
    const controller = new AbortController()
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              return nextGate.promise
            },
            return: async () => {
              throw cleanup
            },
          }
        },
      },
      '8',
      controller.signal,
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    controller.abort(new DOMException('client disconnected', 'AbortError'))
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)

    nextGate.reject(primary)
    await expect(pending).rejects.toBe(primary)
    expect((primary as Error & { suppressed: unknown[] }).suppressed).toEqual([cleanup])
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('queues consumer return behind pending next before releasing the stream pin', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    let nextCalls = 0
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              return nextGate.promise
            },
            return: close,
          }
        },
      },
      '9',
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    const returned = iterator.return?.()
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)
    expect(close).not.toHaveBeenCalled()

    nextGate.resolve({ done: false, value: new TextEncoder().encode('second\n') })
    await expect(pending).resolves.toMatchObject({ done: false })
    await expect(returned).resolves.toMatchObject({ done: true })
    expect(close).toHaveBeenCalledOnce()
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('queues consumer throw behind pending next and keeps cleanup secondary', async () => {
    const nextGate = deferred<IteratorResult<Uint8Array>>()
    const primary = new Error('consumer stopped export')
    const cleanup = new Error('converter close failed')
    let nextCalls = 0
    const prepared = await prepareMockedConverterExport(
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              nextCalls += 1
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode('first\n'),
                })
              }
              return nextGate.promise
            },
            return: async () => {
              throw cleanup
            },
          }
        },
      },
      '0',
    )
    const iterator = prepared.result.bytes[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(prepared.cache.evict(prepared.key)).toBe(false)

    const pending = iterator.next()
    await eventually(() => expect(nextCalls).toBe(2))
    const thrown = iterator.throw?.(primary)
    await nextEventLoopTurn()
    expect(prepared.cache.usedBytes).toBeGreaterThan(0)

    nextGate.resolve({ done: false, value: new TextEncoder().encode('second\n') })
    await expect(pending).resolves.toMatchObject({ done: false })
    await expect(thrown).rejects.toBe(primary)
    expect((primary as Error & { suppressed: unknown[] }).suppressed).toEqual([cleanup])
    await eventually(() => expect(prepared.cache.usedBytes).toBe(0))
  })

  test('rejects mutable refs for export before consulting Catalog', async () => {
    const rig = createRig()
    await expect(
      rig.workspace.export('main', {
        converter: 'canonical-jsonl',
        options: {},
        accepted_fidelity_digest: null,
      }),
    ).rejects.toBeDefined()
    expect(rig.catalog.getRef).not.toHaveBeenCalled()
    expect(rig.store.read).not.toHaveBeenCalled()
  })
})

test('rejects undersized or cross-Workspace cache injection', () => {
  const events: string[] = []
  const catalog = new FakeCatalog(events)
  const limits = { max_records: 1, max_canonical_bytes: 1024, max_record_bytes: 1024 }
  const store = new FakeStore(events, limits)
  const undersized = new V2DatasetCache({ capacityBytes: 1, maxEntryWeight: 1 })
  expect(
    () =>
      new V2Workspace({
        catalog,
        store,
        cursorSecret: CURSOR_SECRET,
        cache: undersized,
        datasetLimits: limits,
      }),
  ).toThrow(TypeError)

  const cache = new V2DatasetCache({ capacityBytes: 2560, maxEntryWeight: 1280 })
  new V2Workspace({ catalog, store, cursorSecret: CURSOR_SECRET, cache, datasetLimits: limits })
  expect(
    () =>
      new V2Workspace({
        catalog,
        store,
        cursorSecret: CURSOR_SECRET,
        cache,
        datasetLimits: limits,
      }),
  ).toThrowError('A V2 dataset cache cannot be shared across Workspace instances')
})

describe('V2Workspace production runtime', () => {
  test('derives a controlled non-root absolute temp directory', () => {
    expect(v2WorkspaceTempRoot('/var/lib/databench')).toBe('/var/lib/databench/.databench-v2-temp')
    expect(v2WorkspaceTempRoot('./bench')).toMatch(/^\/.*\/bench\/\.databench-v2-temp$/)
    expect(() => v2WorkspaceTempRoot('/')).toThrowError(
      'V2 Workspace root must not be the filesystem root',
    )
  })

  test('opens the production S3 runtime and closes its owned Catalog exactly once', async () => {
    const close = vi.spyOn(V2Catalog.prototype, 'close').mockResolvedValue()
    try {
      const workspace = await V2Workspace.open({
        root: '/tmp/databench-v2-runtime-factory',
        cursorSecret: CURSOR_SECRET,
        storeConfig: {
          kind: 's3',
          bucket: 'databench',
          region: 'us-east-1',
          endpoint: 'http://localhost:9000',
        },
      })

      await Promise.all([workspace.close(), workspace.close(), workspace.close()])
      expect(close).toHaveBeenCalledOnce()
    } finally {
      close.mockRestore()
    }
  })

  test('opens the production OSS runtime without eagerly requiring network access', async () => {
    const close = vi.spyOn(V2Catalog.prototype, 'close').mockResolvedValue()
    try {
      const workspace = await V2Workspace.open({
        root: '/tmp/databench-v2-runtime-factory',
        cursorSecret: CURSOR_SECRET,
        storeConfig: {
          kind: 'oss',
          bucket: 'databench',
          region: 'oss-cn-hangzhou',
          accessKeyId: 'test-access-key',
          accessKeySecret: 'test-access-secret',
        },
      })

      await workspace.close()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      close.mockRestore()
    }
  })

  test('closes an owned Catalog when production runtime construction fails', async () => {
    const close = vi.spyOn(V2Catalog.prototype, 'close').mockResolvedValue()
    try {
      await expect(
        V2Workspace.open({
          root: '/tmp/databench-v2-runtime-factory',
          cursorSecret: 'too-short',
          storeConfig: {
            kind: 's3',
            bucket: 'databench',
            region: 'us-east-1',
          },
        }),
      ).rejects.toThrowError('V2 cursor secret must contain at least 16 bytes')
      expect(close).toHaveBeenCalledOnce()
    } finally {
      close.mockRestore()
    }
  })

  test('reports immutable runtime limits and converters from the configured registries', () => {
    const events: string[] = []
    const datasetLimits = {
      max_records: 12,
      max_canonical_bytes: 8192,
      max_record_bytes: 2048,
    }
    const workspace = new V2Workspace({
      catalog: new FakeCatalog(events),
      store: new FakeStore(events),
      cursorSecret: CURSOR_SECRET,
      datasetLimits,
      jsonlLimits: {
        max_request_bytes: 16_384,
        max_nesting_depth: 32,
      },
      transformLimits: {
        max_input_datasets: 3,
        max_working_set_bytes: 32_768,
        max_concurrent_runs: 4,
      },
    })

    const capability = workspace.postTrainingV2Capability()
    expect(capability).toMatchObject({
      enabled: true,
      api_versions: ['2'],
      record_schema_versions: ['2.0.0'],
      identity_profiles: ['databench-v2-jcs-1'],
      layout_versions: ['record-json-v1'],
      export_fidelity_profiles: ['databench-export-fidelity-1'],
      converters: ['canonical-jsonl', 'ms-swift', 'trl-dpo', 'trl-grpo-rlvr', 'trl-sft'],
      limits: {
        max_record_bytes: 2048,
        max_snapshot_records: 12,
        max_canonical_bytes: 8192,
        max_request_bytes: 16_384,
        max_nesting_depth: 32,
        max_json_schema_bytes: 65_536,
        max_json_schema_nodes: 4096,
        max_lineage_depth: 32,
        max_lineage_nodes: 1000,
        max_transform_inputs: 3,
        max_transform_working_set_bytes: 32_768,
        max_concurrent_transforms: 4,
      },
    })
    expect(Object.isFrozen(capability)).toBe(true)
    expect(Object.isFrozen(capability.converters)).toBe(true)
    expect(Object.isFrozen(capability.limits)).toBe(true)
    expect(workspace.postTrainingV2Capability()).toBe(capability)
    expect(
      postTrainingV2Capability({
        datasetLimits,
        jsonlLimits: {
          max_request_bytes: 16_384,
          max_nesting_depth: 32,
        },
        transformLimits: {
          max_input_datasets: 3,
          max_working_set_bytes: 32_768,
          max_concurrent_runs: 4,
        },
      }),
    ).toEqual(capability)
  })
})

interface FakeFailures {
  prepare?: unknown
  commit?: unknown
  discard?: unknown
  audit?: unknown
}

class FakeStore implements V2Store {
  readonly readDatasetLimits: Readonly<V2DatasetLimits>
  readonly committed = new Map<string, V2Dataset>()
  readonly manifests = new Map<string, Readonly<DatasetManifestV2>>()
  readonly preparedDatasets: V2Dataset[] = []
  readonly discardContexts: V2OperationContext[] = []
  readonly failures: FakeFailures = {}
  readonly readGates = new Map<string, Promise<void>>()
  beforeCommit: (() => void) | undefined
  commitManifest: Readonly<DatasetManifestV2> | undefined

  constructor(
    private readonly events: string[],
    readDatasetLimits: V2DatasetLimits = DEFAULT_V2_DATASET_LIMITS,
  ) {
    this.readDatasetLimits = Object.freeze({ ...readDatasetLimits })
  }

  readonly prepare = vi.fn(
    async (dataset: V2Dataset, _context: V2OperationContext = {}): Promise<PreparedArtifactV2> => {
      this.events.push('prepare')
      if (this.failures.prepare !== undefined) throw this.failures.prepare
      this.preparedDatasets.push(dataset)
      const identity: DatasetLayoutIdentityV2 = {
        identity_profile: dataset.identity.identity_profile,
        record_schema_version: dataset.identity.record_schema_version,
        dataset_version: dataset.version,
        num_records: dataset.length,
        layout_version: 'record-json-v1',
        artifact_digest: artifactDigest(dataset.version),
        artifact_size_bytes: Math.max(1, dataset.canonicalBytes),
      }
      const manifest = createDatasetManifestV2(identity)
      return { identity, manifest } as PreparedArtifactV2
    },
  )

  readonly commit = vi.fn(
    async (
      prepared: PreparedArtifactV2,
      _context: V2OperationContext = {},
    ): Promise<Readonly<DatasetManifestV2>> => {
      this.events.push('commit')
      this.beforeCommit?.()
      if (this.failures.commit !== undefined) throw this.failures.commit
      const dataset = this.preparedDatasets.find(
        (candidate) => candidate.version === prepared.identity.dataset_version,
      )
      if (!dataset) throw new Error('prepared dataset was not retained by fake')
      this.committed.set(dataset.version, dataset)
      this.manifests.set(dataset.version, prepared.manifest)
      return this.commitManifest ?? prepared.manifest
    },
  )

  readonly discard = vi.fn(
    async (prepared: PreparedArtifactV2, context: V2OperationContext = {}): Promise<void> => {
      this.events.push('discard')
      void prepared
      this.discardContexts.push(context)
      if (this.failures.discard !== undefined) throw this.failures.discard
    },
  )

  readonly exists = vi.fn(
    async (
      identity: DatasetLayoutIdentityV2,
      _context: V2OperationContext = {},
    ): Promise<boolean> => {
      this.events.push('exists')
      return this.committed.has(identity.dataset_version)
    },
  )

  readonly read = vi.fn(
    async (
      identity: DatasetLayoutIdentityV2,
      _context: V2OperationContext = {},
    ): Promise<V2Dataset> => {
      this.events.push('read')
      await this.readGates.get(identity.dataset_version)
      const dataset = this.committed.get(identity.dataset_version)
      if (!dataset) throw new NotFoundError('fake Store layout is missing')
      return dataset
    },
  )

  readonly audit = vi.fn(
    async (
      identity: DatasetLayoutIdentityV2,
      _context: V2OperationContext = {},
    ): Promise<StoreAuditResultV2> => {
      this.events.push('audit')
      if (this.failures.audit !== undefined) throw this.failures.audit
      const manifest = this.manifests.get(identity.dataset_version)
      if (!manifest) throw new NotFoundError('fake Store manifest is missing')
      return { ok: true, identity, manifest }
    },
  )

  readonly ping = vi.fn(async (_context: V2OperationContext = {}): Promise<void> => undefined)

  seed(dataset: V2Dataset): Readonly<DatasetManifestV2> {
    const identity: DatasetLayoutIdentityV2 = {
      identity_profile: dataset.identity.identity_profile,
      record_schema_version: dataset.identity.record_schema_version,
      dataset_version: dataset.version,
      num_records: dataset.length,
      layout_version: 'record-json-v1',
      artifact_digest: artifactDigest(dataset.version),
      artifact_size_bytes: Math.max(1, dataset.canonicalBytes),
    }
    const manifest = createDatasetManifestV2(identity)
    this.committed.set(dataset.version, dataset)
    this.manifests.set(dataset.version, manifest)
    return manifest
  }
}

class FakeCatalog implements V2WorkspaceCatalog {
  readonly snapshots = new Map<string, CatalogSnapshotRowV2>()
  readonly layouts = new Map<string, CatalogLayoutRowV2>()
  readonly refs = new Map<string, CatalogRefRowV2>()
  readonly runs = new Map<string, CatalogRunRowV2>()
  readonly claims = new Map<string, CatalogIdentityClaimRowV2>()
  readonly listPages = new Map<string | null, CatalogRefPageV2>()
  readonly deletedListPages = new Map<string | null, CatalogRefPageV2>()
  readonly registrations: RegisterLayoutV2[] = []
  readonly failures: { register?: unknown; cas?: unknown; delete?: unknown; restore?: unknown } = {}
  transformConflictOutput: string | undefined
  #nextRunSequence = 1n

  constructor(private readonly events: string[]) {}

  readonly getOrCreateNamespace = vi.fn(async (_scope: 'default'): Promise<string> => {
    this.events.push('namespace')
    return NAMESPACE_ID
  })

  readonly insertOrReadIdentityClaim = vi.fn(
    async (input: CatalogIdentityClaimInputV2): Promise<CatalogIdentityClaimResultV2> => {
      this.events.push('claim')
      const byClaim = this.claims.get(input.claimKeyDigest)
      if (byClaim) return { status: 'existing_claim', row: byClaim }
      const byEntity = [...this.claims.values()].find(({ entityId }) => entityId === input.entityId)
      if (byEntity) return { status: 'existing_entity', row: byEntity }
      const row = { ...input, createdAt: NOW }
      this.claims.set(input.claimKeyDigest, row)
      return { status: 'created', row }
    },
  )

  readonly registerCommittedLayout = vi.fn(async (input: RegisterLayoutV2): Promise<void> => {
    this.events.push('register')
    if (this.failures.register !== undefined) throw this.failures.register
    this.registrations.push(input)
    this.snapshots.set(input.snapshot.version, { ...input.snapshot, createdAt: NOW })
    this.layouts.set(input.layout.datasetVersion, { ...input.layout, committedAt: NOW })
  })

  readonly registerTransformResult = vi.fn(
    async (input: RegisterTransformResultV2): Promise<void> => {
      this.events.push('registerTransform')
      const existing = this.runs.get(input.run.cacheKey)
      if (existing) {
        if (existing.outputVersion !== input.run.outputVersion) {
          throw new V2CatalogDeterminismConflictError(input.run.cacheKey)
        }
        return
      }
      if (this.transformConflictOutput !== undefined) {
        this.runs.set(input.run.cacheKey, {
          ...input.run,
          lineageSequence: this.#allocateRunSequence(),
          outputVersion: this.transformConflictOutput,
          createdAt: NOW,
        })
        throw new V2CatalogDeterminismConflictError(input.run.cacheKey)
      }
      await this.registerCommittedLayout(input)
      this.runs.set(input.run.cacheKey, {
        ...input.run,
        lineageSequence: this.#allocateRunSequence(),
        createdAt: NOW,
      })
    },
  )

  readonly findRun = vi.fn(async (cacheKey: string): Promise<CatalogRunRowV2 | null> => {
    this.events.push('findRun')
    return this.runs.get(cacheKey) ?? null
  })

  readonly lineageSnapshotSequence = vi.fn(
    async (): Promise<bigint> =>
      [...this.runs.values()].reduce(
        (maximum, row) => (row.lineageSequence > maximum ? row.lineageSequence : maximum),
        0n,
      ),
  )

  readonly listRunsProducing = vi.fn(
    async (
      version: string,
      afterCacheKey: string | null,
      limit: number,
      lineageSequenceAtOrBefore: bigint,
    ): Promise<CatalogRunPageV2> => {
      this.events.push('listRunsProducing')
      const rows = [...this.runs.values()]
        .filter(
          (row) =>
            row.outputVersion === version &&
            row.lineageSequence <= lineageSequenceAtOrBefore &&
            (afterCacheKey === null || row.cacheKey > afterCacheKey),
        )
        .sort((left, right) => (left.cacheKey < right.cacheKey ? -1 : 1))
      const visible = rows.slice(0, limit)
      return {
        rows: visible,
        nextCacheKey: rows.length > limit ? (visible.at(-1)?.cacheKey ?? null) : null,
      }
    },
  )

  #allocateRunSequence(): bigint {
    const value = this.#nextRunSequence
    this.#nextRunSequence += 1n
    return value
  }

  readonly getSnapshot = vi.fn(async (version: string): Promise<CatalogSnapshotRowV2 | null> => {
    this.events.push('getSnapshot')
    return this.snapshots.get(version) ?? null
  })

  readonly getLayout = vi.fn(
    async (version: string, _layout: string): Promise<CatalogLayoutRowV2 | null> => {
      this.events.push('getLayout')
      return this.layouts.get(version) ?? null
    },
  )

  readonly getRef = vi.fn(
    async (_namespaceId: string, name: string): Promise<CatalogRefRowV2 | null> => {
      this.events.push('getRef')
      const row = this.refs.get(name)
      return row?.deletedAt === null ? row : null
    },
  )

  readonly getDeletedRef = vi.fn(
    async (_namespaceId: string, name: string): Promise<CatalogRefRowV2 | null> => {
      this.events.push('getDeletedRef')
      const row = this.refs.get(name)
      return row?.deletedAt instanceof Date ? row : null
    },
  )

  readonly compareAndSetRef = vi.fn(async (input: CompareAndSetRefV2): Promise<CatalogRefRowV2> => {
    this.events.push('cas')
    if (this.failures.cas !== undefined) throw this.failures.cas
    const row = refRow(input.name, input.newVersion, input.message)
    this.refs.set(input.name, row)
    return row
  })

  readonly deleteRef = vi.fn(async (input: DeleteRefV2): Promise<CatalogDeleteRefResultV2> => {
    this.events.push('deleteRef')
    if (this.failures.delete !== undefined) throw this.failures.delete
    const current = this.refs.get(input.name)
    if (current === undefined) return { status: 'missing' }
    if (current.version !== input.expectedVersion) {
      throw new V2CatalogRefStateConflictError({
        namespaceId: input.namespaceId,
        refName: input.name,
        expectedVersion: input.expectedVersion,
        currentVersion: current.version,
        currentState: current.deletedAt === null ? 'active' : 'deleted',
        operation: 'delete',
      })
    }
    if (current.deletedAt !== null) return { status: 'already_deleted', row: current }
    const row = { ...current, deletedAt: NOW }
    this.refs.set(input.name, row)
    return { status: 'deleted', row }
  })

  readonly listRefs = vi.fn(
    async (
      _namespaceId: string,
      afterName: string | null,
      _limit: number,
    ): Promise<CatalogRefPageV2> => {
      this.events.push('listRefs')
      return this.listPages.get(afterName) ?? { rows: [], nextName: null }
    },
  )

  readonly listDeletedRefs = vi.fn(
    async (
      _namespaceId: string,
      afterName: string | null,
      _limit: number,
    ): Promise<CatalogRefPageV2> => {
      this.events.push('listDeletedRefs')
      return this.deletedListPages.get(afterName) ?? { rows: [], nextName: null }
    },
  )

  readonly restoreRef = vi.fn(async (input: RestoreRefV2): Promise<CatalogRestoreRefResultV2> => {
    this.events.push('restoreRef')
    if (this.failures.restore !== undefined) throw this.failures.restore
    const current = this.refs.get(input.name)
    if (current === undefined) return { status: 'missing' }
    if (current.version !== input.expectedVersion) {
      throw new V2CatalogRefStateConflictError({
        namespaceId: input.namespaceId,
        refName: input.name,
        expectedVersion: input.expectedVersion,
        currentVersion: current.version,
        currentState: current.deletedAt === null ? 'active' : 'deleted',
        operation: 'restore',
      })
    }
    if (current.deletedAt === null) return { status: 'already_active', row: current }
    const row = { ...current, deletedAt: null }
    this.refs.set(input.name, row)
    return { status: 'restored', row }
  })
}

interface TestRig {
  readonly events: string[]
  readonly store: FakeStore
  readonly catalog: FakeCatalog
  readonly workspace: V2Workspace
  readonly cleanupErrors: Array<{ readonly error: unknown; readonly primaryError: unknown | null }>
  readonly seed: (dataset: V2Dataset) => void
  readonly seedCatalogOnly: (dataset: V2Dataset) => void
}

function createRig(
  transformLimits: Partial<V2TransformLimits> = {},
  transformRegistry?: V2TransformRegistry,
  converterRegistry?: V2ConverterRegistry,
  cache?: V2DatasetCache,
): TestRig {
  const events: string[] = []
  const store = new FakeStore(events)
  const catalog = new FakeCatalog(events)
  const cleanupErrors: Array<{ readonly error: unknown; readonly primaryError: unknown | null }> =
    []
  const workspace = new V2Workspace({
    catalog,
    store,
    cursorSecret: CURSOR_SECRET,
    transformLimits,
    ...(transformRegistry === undefined ? {} : { transformRegistry }),
    ...(converterRegistry === undefined ? {} : { converterRegistry }),
    ...(cache === undefined ? {} : { cache }),
    onCleanupError: (error, primaryError) => cleanupErrors.push({ error, primaryError }),
  })

  const register = (dataset: V2Dataset, manifest: Readonly<DatasetManifestV2>): void => {
    const registration = registrationFromCommittedDataset(dataset, manifest)
    catalog.snapshots.set(registration.snapshot.version, {
      ...registration.snapshot,
      createdAt: NOW,
    })
    catalog.layouts.set(registration.layout.datasetVersion, {
      ...registration.layout,
      committedAt: NOW,
    })
  }

  return {
    events,
    store,
    catalog,
    workspace,
    cleanupErrors,
    seed(dataset) {
      register(dataset, store.seed(dataset))
    },
    seedCatalogOnly(dataset) {
      const identity: DatasetLayoutIdentityV2 = {
        identity_profile: dataset.identity.identity_profile,
        record_schema_version: dataset.identity.record_schema_version,
        dataset_version: dataset.version,
        num_records: dataset.length,
        layout_version: 'record-json-v1',
        artifact_digest: artifactDigest(dataset.version),
        artifact_size_bytes: Math.max(1, dataset.canonicalBytes),
      }
      register(dataset, createDatasetManifestV2(identity))
    },
  }
}

function noRef() {
  return { ref: null, expected_ref_version: null, message: null } as const
}

async function prepareMockedConverterExport(
  source: AsyncIterable<Uint8Array>,
  idDigit: string,
  signal?: AbortSignal,
) {
  const requiredWeight = v2DatasetCacheRequiredWeight(DEFAULT_V2_DATASET_LIMITS)
  const cache = new V2DatasetCache({
    capacityBytes: requiredWeight,
    maxEntryWeight: requiredWeight,
  })
  const registry = createDefaultV2ConverterRegistry()
  vi.spyOn(registry, 'stream').mockReturnValue(source)
  const rig = createRig({}, undefined, registry, cache)
  const dataset = makeDataset(idDigit, 'controlled converter stream')
  rig.seed(dataset)
  const result = await rig.workspace.export(
    dataset.version,
    {
      converter: 'canonical-jsonl',
      options: {},
      accepted_fidelity_digest: null,
    },
    signal === undefined ? {} : { signal },
  )
  return {
    cache,
    result,
    key: {
      dataset_version: dataset.version,
      layout_version: 'record-json-v1',
      artifact_digest: artifactDigest(dataset.version),
    },
  }
}

function makeDataset(idDigit: string, text: string): V2Dataset {
  return V2Dataset.fromRecords([makeRecord(idDigit, text)])
}

function makeRecord(idDigit: string, text: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${idDigit.repeat(64)}`,
    contents: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text,
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: null,
      },
    ],
    candidates: [],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

function makeSelectedSftRecord(idDigit: string): PostTrainingRecordV2 {
  const record = makeRecord(idDigit, 'semantic loss prompt')
  return {
    ...record,
    contents: record.contents.map((content) => ({ ...content, loss_weight: 1 })),
    candidates: [
      {
        id: `cand_${idDigit.repeat(64)}`,
        contents: [
          {
            role: 'ai',
            parts: [
              {
                type: 'text',
                text: 'selected answer',
                thought: false,
                thought_signature: null,
                part_metadata: {},
              },
            ],
            loss_weight: null,
          },
        ],
        finish_reason: null,
        rank: null,
        selected: true,
        signals: [],
        generator: null,
        token_count: null,
        avg_logprobs: null,
      },
    ],
  }
}

function refRow(
  name: string,
  version: string,
  message: string | null,
  deletedAt: Date | null = null,
): CatalogRefRowV2 {
  return {
    namespaceId: NAMESPACE_ID,
    name,
    version,
    numRecords: 0n,
    message,
    updatedAt: NOW,
    deletedAt,
  }
}

function artifactDigest(datasetVersion: string): string {
  const first = datasetVersion[0] ?? '0'
  return first.repeat(64)
}

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  let rejectPromise: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (!resolvePromise || !rejectPromise) throw new Error('failed to create deferred promise')
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion()
      return
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  assertion()
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
