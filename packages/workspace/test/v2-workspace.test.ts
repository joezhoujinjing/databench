import { readFileSync } from 'node:fs'
import {
  type CatalogLayoutRowV2,
  type CatalogRefPageV2,
  type CatalogRefRowV2,
  type CatalogSnapshotRowV2,
  type CompareAndSetRefV2,
  type RegisterLayoutV2,
  V2CatalogRefConflictError,
  V2CatalogTargetNotCommittedError,
} from '@databench/catalog'
import { DEFAULT_V2_DATASET_LIMITS, V2Dataset, type V2DatasetLimits } from '@databench/engine'
import {
  CapacityExceededError,
  createDatasetManifestV2,
  type DatasetLayoutIdentityV2,
  type DatasetManifestV2,
  IntegrityError,
  NotFoundError,
  type PostTrainingRecordV2,
  RefConflictErrorV2,
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
  registrationFromCommittedDataset,
  V2DatasetCache,
  V2Workspace,
  type V2WorkspaceCatalog,
  v2DatasetCacheWeight,
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

const fixture = JSON.parse(
  readFileSync(
    new URL('./golden/fixtures/v2/workspace-publish-read-cache-ref.fixture.json', import.meta.url),
    'utf8',
  ),
) as WorkspaceV2Fixture

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
  readonly listPages = new Map<string | null, CatalogRefPageV2>()
  readonly registrations: RegisterLayoutV2[] = []
  readonly failures: { register?: unknown; cas?: unknown } = {}

  constructor(private readonly events: string[]) {}

  readonly getOrCreateNamespace = vi.fn(async (_scope: 'default'): Promise<string> => {
    this.events.push('namespace')
    return NAMESPACE_ID
  })

  readonly registerCommittedLayout = vi.fn(async (input: RegisterLayoutV2): Promise<void> => {
    this.events.push('register')
    if (this.failures.register !== undefined) throw this.failures.register
    this.registrations.push(input)
    this.snapshots.set(input.snapshot.version, { ...input.snapshot, createdAt: NOW })
    this.layouts.set(input.layout.datasetVersion, { ...input.layout, committedAt: NOW })
  })

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
      return this.refs.get(name) ?? null
    },
  )

  readonly compareAndSetRef = vi.fn(async (input: CompareAndSetRefV2): Promise<CatalogRefRowV2> => {
    this.events.push('cas')
    if (this.failures.cas !== undefined) throw this.failures.cas
    const row = refRow(input.name, input.newVersion, input.message)
    this.refs.set(input.name, row)
    return row
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

function createRig(): TestRig {
  const events: string[] = []
  const store = new FakeStore(events)
  const catalog = new FakeCatalog(events)
  const cleanupErrors: Array<{ readonly error: unknown; readonly primaryError: unknown | null }> =
    []
  const workspace = new V2Workspace({
    catalog,
    store,
    cursorSecret: CURSOR_SECRET,
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

function makeDataset(idDigit: string, text: string): V2Dataset {
  return V2Dataset.fromRecords([makeRecord(idDigit, text)])
}

function makeRecord(idDigit: string, text: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${idDigit.repeat(64)}`,
    system_instruction: null,
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

function refRow(name: string, version: string, message: string | null): CatalogRefRowV2 {
  return { namespaceId: NAMESPACE_ID, name, version, message, updatedAt: NOW }
}

function artifactDigest(datasetVersion: string): string {
  const first = datasetVersion[0] ?? '0'
  return first.repeat(64)
}
