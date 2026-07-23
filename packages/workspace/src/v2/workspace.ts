import type {
  CatalogLayoutRowV2,
  CatalogRefPageV2,
  CatalogRefRowV2,
  CatalogSnapshotRowV2,
  CompareAndSetRefV2,
  RegisterLayoutV2,
} from '@databench/catalog'
import { DEFAULT_V2_DATASET_LIMITS, V2Dataset, type V2DatasetLimits } from '@databench/engine'
import { readCanonicalJsonlV2 } from '@databench/io'
import {
  type AddRecordsV2Options,
  AddRecordsV2OptionsSchema,
  type AuditResultV2,
  AuditResultV2Schema,
  type CursorPageRequestV2,
  CursorPageRequestV2Schema,
  createRecordSummaryV2,
  type DatasetLayoutIdentityV2,
  type DatasetViewV2,
  DatasetViewV2Schema,
  datasetLayoutIdentityV2FromManifest,
  deriveRecordEligibilityV2,
  type IngestResultV2,
  IngestResultV2Schema,
  IntegrityError,
  NotFoundError,
  type PutRefRequestV2,
  PutRefRequestV2Schema,
  RecordIdV2Schema,
  type RecordPageRequestV2,
  RecordPageRequestV2Schema,
  type RecordPageV2,
  RecordPageV2Schema,
  type RecordViewV2,
  RecordViewV2Schema,
  type RefMetadataV2,
  RefMetadataV2Schema,
  RefNameV2Schema,
  RefOrVersionV2Schema,
  type RefPageV2,
  RefPageV2Schema,
  V2_RECORD_JSON_LAYOUT_VERSION,
} from '@databench/schema'
import type { PreparedArtifactV2, V2OperationContext, V2Store } from '@databench/store'
import {
  V2DatasetCache,
  type V2DatasetCacheKey,
  type V2DatasetLease,
  v2DatasetCacheRequiredWeight,
} from './cache.js'
import { V2CursorCodec } from './cursor.js'
import {
  layoutIdentityFromCatalog,
  manifestFromCatalogIdentity,
  mapV2CatalogError,
  refMetadataFromCatalog,
  registrationFromCommittedDataset,
} from './mappings.js'

const EXACT_VERSION = /^[0-9a-f]{64}$/
const DEFAULT_V2_CACHE_ENTRIES = 2
const claimedWorkspaceCaches = new WeakSet<V2DatasetCache>()

export interface V2WorkspaceCatalog {
  getOrCreateNamespace(scope: 'default'): Promise<string>
  registerCommittedLayout(input: RegisterLayoutV2): Promise<void>
  getSnapshot(version: string): Promise<CatalogSnapshotRowV2 | null>
  getLayout(version: string, layout: string): Promise<CatalogLayoutRowV2 | null>
  getRef(namespaceId: string, name: string): Promise<CatalogRefRowV2 | null>
  compareAndSetRef(input: CompareAndSetRefV2): Promise<CatalogRefRowV2>
  listRefs(namespaceId: string, afterName: string | null, limit: number): Promise<CatalogRefPageV2>
}

export interface V2WorkspaceOperationOptions extends V2OperationContext {}

export interface V2WorkspaceOptions {
  readonly catalog: V2WorkspaceCatalog
  readonly store: V2Store
  readonly cursorSecret: Uint8Array | string
  readonly cache?: V2DatasetCache
  readonly datasetLimits?: V2DatasetLimits
  readonly onCleanupError?: (error: unknown, primaryError: unknown | null) => void
}

interface ResolvedLayoutV2 {
  readonly requestedRef: string
  readonly refName: string | null
  readonly identity: Readonly<DatasetLayoutIdentityV2>
}

type CleanupOutcomeV2 =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown }

/**
 * Trusted-boundary orchestration for immutable v2 datasets.
 *
 * A workspace instance owns one Catalog namespace, one object namespace, and
 * one process-local cache. Authentication and tenant selection must therefore
 * happen before a caller chooses and enters this instance.
 */
export class V2Workspace {
  readonly #catalog: V2WorkspaceCatalog
  readonly #store: V2Store
  readonly #cache: V2DatasetCache
  readonly #cursor: V2CursorCodec
  readonly #datasetLimits: Readonly<V2DatasetLimits>
  readonly #onCleanupError: ((error: unknown, primaryError: unknown | null) => void) | undefined
  #namespacePromise: Promise<string> | undefined

  constructor(options: V2WorkspaceOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('V2Workspace options must be an object')
    }
    if (!options.catalog || typeof options.catalog !== 'object') {
      throw new TypeError('V2Workspace catalog is required')
    }
    if (!options.store || typeof options.store !== 'object') {
      throw new TypeError('V2Workspace store is required')
    }
    this.#catalog = options.catalog
    this.#store = options.store
    this.#cursor = new V2CursorCodec(options.cursorSecret)
    this.#datasetLimits = snapshotDatasetLimits(options.datasetLimits ?? DEFAULT_V2_DATASET_LIMITS)
    const storeReadLimits = snapshotDatasetLimits(options.store.readDatasetLimits)
    assertIngestLimitsReadable(this.#datasetLimits, storeReadLimits)
    const requiredCacheWeight = v2DatasetCacheRequiredWeight(storeReadLimits)
    const cache =
      options.cache ??
      new V2DatasetCache({
        capacityBytes: checkedMultiply(requiredCacheWeight, DEFAULT_V2_CACHE_ENTRIES),
        maxEntryWeight: requiredCacheWeight,
      })
    if (cache.maxEntryWeight < requiredCacheWeight || cache.capacityBytes < requiredCacheWeight) {
      throw new TypeError('V2Workspace cache cannot reserve the configured dataset limit')
    }
    if (claimedWorkspaceCaches.has(cache)) {
      throw new TypeError('A V2 dataset cache cannot be shared across Workspace instances')
    }
    claimedWorkspaceCaches.add(cache)
    this.#cache = cache
    this.#onCleanupError = options.onCleanupError
  }

  async addRecords(
    records: Iterable<unknown>,
    optionsInput: AddRecordsV2Options,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<IngestResultV2> {
    context.signal?.throwIfAborted()
    const options = AddRecordsV2OptionsSchema.parse(optionsInput)
    const dataset = V2Dataset.fromRecords(
      abortableRecords(records, context.signal),
      this.#datasetLimits,
    )
    context.signal?.throwIfAborted()
    return await this.#publish(dataset, options, context.signal)
  }

  async addJsonl(
    source: AsyncIterable<Uint8Array>,
    optionsInput: AddRecordsV2Options,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<IngestResultV2> {
    context.signal?.throwIfAborted()
    const options = AddRecordsV2OptionsSchema.parse(optionsInput)
    const records = readCanonicalJsonlV2(source, {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    const dataset = await V2Dataset.fromAsyncRecords(records, this.#datasetLimits, context)
    return await this.#publish(dataset, options, context.signal)
  }

  async get(
    refOrVersionInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<V2Dataset> {
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      return lease.dataset
    } finally {
      lease.release()
    }
  }

  /**
   * Holds the cache lease for the complete consumer callback. Multi-input
   * orchestration (notably V10 transforms) must use this form, together with
   * its aggregate working-set admission, instead of retaining bare get()
   * results across loads.
   */
  async withDataset<T>(
    refOrVersionInput: string,
    consume: (dataset: V2Dataset, exactVersion: string) => T | Promise<T>,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<T> {
    if (typeof consume !== 'function') {
      throw new TypeError('V2Workspace dataset consumer must be a function')
    }
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      context.signal?.throwIfAborted()
      return await consume(lease.dataset, resolved.identity.dataset_version)
    } finally {
      lease.release()
    }
  }

  async describeDataset(
    refOrVersionInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<DatasetViewV2> {
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const key = cacheKey(resolved.identity)
    let exists: boolean
    try {
      exists = await this.#store.exists(resolved.identity, operationContext(context.signal))
    } catch (error) {
      const mapped = this.#mapRegisteredObjectError(error, resolved.identity)
      if (mapped instanceof IntegrityError) this.#cache.evict(key)
      throw mapped
    }
    if (!exists) {
      this.#cache.evict(key)
      throw registeredObjectMissing(resolved.identity, 'manifest_missing')
    }
    return DatasetViewV2Schema.parse({
      requested_ref: resolved.requestedRef,
      ref_name: resolved.refName,
      dataset_version: resolved.identity.dataset_version,
      manifest: manifestFromCatalogIdentity(resolved.identity),
    })
  }

  async getRecordPage(
    refOrVersionInput: string,
    requestInput: RecordPageRequestV2,
    context?: V2WorkspaceOperationOptions,
  ): Promise<RecordPageV2>
  async getRecordPage(
    refOrVersionInput: string,
    offset: number,
    limit: number,
    context?: V2WorkspaceOperationOptions,
  ): Promise<RecordPageV2>
  async getRecordPage(
    refOrVersionInput: string,
    requestOrOffset: RecordPageRequestV2 | number,
    limitOrContext?: number | V2WorkspaceOperationOptions,
    contextInput: V2WorkspaceOperationOptions = {},
  ): Promise<RecordPageV2> {
    const request = RecordPageRequestV2Schema.parse(
      typeof requestOrOffset === 'number'
        ? { offset: requestOrOffset, limit: limitOrContext }
        : requestOrOffset,
    )
    const context =
      typeof requestOrOffset === 'number'
        ? contextInput
        : ((limitOrContext as V2WorkspaceOperationOptions | undefined) ?? {})
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      return RecordPageV2Schema.parse({
        items: [...lease.dataset.records(request.offset, request.limit)].map(createRecordSummaryV2),
        offset: request.offset,
        limit: request.limit,
        total: lease.dataset.length,
        dataset_version: resolved.identity.dataset_version,
      })
    } finally {
      lease.release()
    }
  }

  async getRecordView(
    refOrVersionInput: string,
    recordId: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RecordViewV2 | null> {
    const parsedRecordId = RecordIdV2Schema.parse(recordId)
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      const revision = lease.dataset.get(parsedRecordId)
      if (revision === null) return null
      return RecordViewV2Schema.parse({
        record: revision.record,
        record_digest: revision.record_digest,
        eligibility: deriveRecordEligibilityV2(revision.record),
        dataset_version: resolved.identity.dataset_version,
      })
    } finally {
      lease.release()
    }
  }

  async audit(
    refOrVersionInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<AuditResultV2> {
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const key = cacheKey(resolved.identity)
    try {
      const audited = await this.#cache.runUncached(
        async (signal) => await this.#store.audit(resolved.identity, { signal }),
        {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      )
      let auditedManifestIdentity: Readonly<DatasetLayoutIdentityV2>
      try {
        auditedManifestIdentity = datasetLayoutIdentityV2FromManifest(audited.manifest)
      } catch (error) {
        throw new IntegrityError('V2 Store audit returned an invalid manifest', {
          reason: 'audit_manifest_invalid',
          dataset_version: resolved.identity.dataset_version,
          cause: error instanceof Error ? error.name : typeof error,
        })
      }
      if (
        !sameLayoutIdentity(audited.identity, resolved.identity) ||
        !sameLayoutIdentity(auditedManifestIdentity, resolved.identity)
      ) {
        throw new IntegrityError('V2 Store audit returned a different layout identity', {
          reason: 'audit_identity_mismatch',
          expected_dataset_version: resolved.identity.dataset_version,
          actual_dataset_version: audited.identity.dataset_version,
        })
      }
      return AuditResultV2Schema.parse({
        dataset_version: audited.identity.dataset_version,
        layout_version: audited.identity.layout_version,
        artifact_digest: audited.identity.artifact_digest,
        artifact_size_bytes: audited.identity.artifact_size_bytes,
        checks: {
          manifest: 'ok',
          artifact_digest: 'ok',
          parquet_schema: 'ok',
          record_digests: 'ok',
          dataset_version: 'ok',
        },
      })
    } catch (error) {
      const mapped = this.#mapRegisteredObjectError(error, resolved.identity)
      if (mapped instanceof IntegrityError) this.#cache.evict(key)
      throw mapped
    }
  }

  async listRefs(
    requestInput: CursorPageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RefPageV2> {
    context.signal?.throwIfAborted()
    const request = CursorPageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const afterName =
      request.cursor === null ? null : this.#cursor.decodeRef(request.cursor, namespaceId)
    context.signal?.throwIfAborted()
    let page: CatalogRefPageV2
    try {
      page = await waitWithAbort(
        this.#catalog.listRefs(namespaceId, afterName, request.limit),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    const validatedPage = validateCatalogRefPage(page, namespaceId, afterName, request.limit)
    return RefPageV2Schema.parse({
      items: validatedPage.items,
      next_cursor:
        validatedPage.nextName === null
          ? null
          : this.#cursor.encodeRef(namespaceId, validatedPage.nextName),
    })
  }

  async getRef(
    nameInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RefMetadataV2 | null> {
    const name = RefNameV2Schema.parse(nameInput)
    const namespaceId = await this.#namespace(context.signal)
    context.signal?.throwIfAborted()
    let row: CatalogRefRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.getRef(namespaceId, name), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row === null) return null
    assertRefRow(row, namespaceId, name, row.version)
    return catalogRefMetadata(row)
  }

  async putRef(
    nameInput: string,
    requestInput: PutRefRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RefMetadataV2> {
    const name = RefNameV2Schema.parse(nameInput)
    const request = PutRefRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    context.signal?.throwIfAborted()
    let row: CatalogRefRowV2
    try {
      row = await this.#catalog.compareAndSetRef({
        namespaceId,
        name,
        newVersion: request.new_version,
        expectedVersion: request.expected_version,
        message: request.message,
      })
    } catch (error) {
      mapV2CatalogError(error, true, false)
    }
    assertRefRow(row, namespaceId, name, request.new_version)
    return catalogRefMetadata(row)
  }

  async #publish(
    dataset: V2Dataset,
    options: AddRecordsV2Options,
    signal?: AbortSignal,
  ): Promise<IngestResultV2> {
    let prepared: PreparedArtifactV2 | undefined
    let result: IngestResultV2 | undefined
    let failed = false
    let failure: unknown
    try {
      signal?.throwIfAborted()
      prepared = await this.#store.prepare(dataset, operationContext(signal))
      const manifest = await this.#store.commit(prepared, operationContext(signal))
      const registration = registrationFromCommittedDataset(dataset, manifest)
      try {
        await this.#catalog.registerCommittedLayout(registration)
      } catch (error) {
        mapV2CatalogError(error, true)
      }

      let refUpdate: IngestResultV2['ref_update'] = { status: 'not_requested' }
      if (options.ref !== null) {
        const namespaceId = await this.#namespace(signal)
        signal?.throwIfAborted()
        let ref: CatalogRefRowV2
        try {
          ref = await this.#catalog.compareAndSetRef({
            namespaceId,
            name: options.ref,
            newVersion: dataset.version,
            expectedVersion: options.expected_ref_version,
            message: options.message,
          })
        } catch (error) {
          mapV2CatalogError(error, true)
        }
        assertRefRow(ref, namespaceId, options.ref, dataset.version)
        refUpdate = {
          status: 'updated',
          ref_name: ref.name,
          previous_version: options.expected_ref_version,
          current_version: ref.version,
        }
      }
      result = IngestResultV2Schema.parse({
        dataset_version: dataset.version,
        manifest,
        ref_update: refUpdate,
      })
    } catch (error) {
      failed = true
      failure = error
    }

    if (prepared !== undefined) {
      const cleanup = await this.#discardPrepared(prepared)
      if (cleanup.failed) {
        if (failed) attachSuppressed(failure, cleanup.error)
        this.#reportCleanupError(cleanup.error, failed ? failure : null)
      }
    }
    if (failed) throw failure
    if (result === undefined) {
      throw new IntegrityError('V2 publish completed without a result', {
        reason: 'publish_result_missing',
      })
    }
    return result
  }

  async #discardPrepared(prepared: PreparedArtifactV2): Promise<CleanupOutcomeV2> {
    let firstFailure: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Cleanup must not inherit an already-aborted business request signal.
        await this.#store.discard(prepared, {})
        return { failed: false }
      } catch (error) {
        if (attempt === 0) firstFailure = error
        else {
          attachSuppressed(error, firstFailure)
          return { failed: true, error }
        }
      }
    }
    throw new IntegrityError('V2 cleanup retry loop terminated unexpectedly')
  }

  #reportCleanupError(error: unknown, primaryError: unknown | null): void {
    if (this.#onCleanupError === undefined) {
      process.emitWarning('V2 prepared artifact cleanup failed after one retry', {
        code: 'DATABENCH_V2_CLEANUP_FAILED',
      })
      return
    }
    try {
      this.#onCleanupError(error, primaryError)
    } catch (handlerError) {
      attachSuppressed(error, handlerError)
    }
  }

  async #resolveLayout(refOrVersionInput: string, signal?: AbortSignal): Promise<ResolvedLayoutV2> {
    signal?.throwIfAborted()
    const requestedRef = RefOrVersionV2Schema.parse(refOrVersionInput)
    let version: string
    let refName: string | null
    if (EXACT_VERSION.test(requestedRef)) {
      version = requestedRef
      refName = null
    } else {
      const namespaceId = await this.#namespace(signal)
      signal?.throwIfAborted()
      let ref: CatalogRefRowV2 | null
      try {
        ref = await waitWithAbort(this.#catalog.getRef(namespaceId, requestedRef), signal)
      } catch (error) {
        if (signal?.aborted) throw error
        mapV2CatalogError(error, false)
      }
      if (ref === null) {
        throw new NotFoundError('V2 ref was not found', { ref_name: requestedRef })
      }
      assertRefRow(ref, namespaceId, requestedRef, ref.version)
      version = ref.version
      refName = requestedRef
    }

    signal?.throwIfAborted()
    let snapshot: CatalogSnapshotRowV2 | null
    let layout: CatalogLayoutRowV2 | null
    try {
      ;[snapshot, layout] = await waitWithAbort(
        Promise.all([
          this.#catalog.getSnapshot(version),
          this.#catalog.getLayout(version, V2_RECORD_JSON_LAYOUT_VERSION),
        ]),
        signal,
      )
    } catch (error) {
      if (signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    signal?.throwIfAborted()
    if (snapshot === null && layout === null) {
      if (refName !== null) {
        throw new IntegrityError('V2 ref points to an unregistered dataset', {
          reason: 'ref_target_missing',
          ref_name: refName,
          dataset_version: version,
        })
      }
      throw new NotFoundError('V2 dataset was not found', { dataset_version: version })
    }
    if (snapshot === null || layout === null) {
      throw new IntegrityError('V2 catalog dataset registration is incomplete', {
        reason: snapshot === null ? 'snapshot_missing' : 'layout_missing',
        dataset_version: version,
      })
    }
    return Object.freeze({
      requestedRef,
      refName,
      identity: layoutIdentityFromCatalog(snapshot, layout),
    })
  }

  async #acquire(
    identity: Readonly<DatasetLayoutIdentityV2>,
    signal?: AbortSignal,
  ): Promise<V2DatasetLease> {
    try {
      return await this.#cache.acquire(
        cacheKey(identity),
        async (loadSignal) => await this.#store.read(identity, { signal: loadSignal }),
        { ...(signal === undefined ? {} : { signal }) },
      )
    } catch (error) {
      throw this.#mapRegisteredObjectError(error, identity)
    }
  }

  #mapRegisteredObjectError(error: unknown, identity: Readonly<DatasetLayoutIdentityV2>): unknown {
    if (error instanceof NotFoundError) {
      return registeredObjectMissing(identity, 'store_layout_missing', error)
    }
    return error
  }

  async #namespace(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    let pending = this.#namespacePromise
    if (pending === undefined) {
      pending = this.#catalog.getOrCreateNamespace('default')
      this.#namespacePromise = pending
      void pending.catch(() => {
        if (this.#namespacePromise === pending) this.#namespacePromise = undefined
      })
    }
    let namespaceId: string
    try {
      namespaceId = await waitWithAbort(pending, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    signal?.throwIfAborted()
    return namespaceId
  }
}

function cacheKey(identity: Readonly<DatasetLayoutIdentityV2>): V2DatasetCacheKey {
  return {
    dataset_version: identity.dataset_version,
    layout_version: identity.layout_version,
    artifact_digest: identity.artifact_digest,
  }
}

function operationContext(signal?: AbortSignal): V2OperationContext {
  return signal === undefined ? {} : { signal }
}

function attachSuppressed(primary: unknown, suppressed: unknown): void {
  if (Object.is(primary, suppressed)) return
  if ((typeof primary !== 'object' && typeof primary !== 'function') || primary === null) return
  const target = primary as { suppressed?: unknown[] }
  try {
    const existing = Array.isArray(target.suppressed) ? target.suppressed : []
    Object.defineProperty(target, 'suppressed', {
      configurable: true,
      value: [...existing, suppressed],
    })
  } catch {
    // A frozen third-party error still remains the primary failure; the
    // cleanup telemetry hook is the fallback visibility path.
  }
}

function* abortableRecords(records: Iterable<unknown>, signal?: AbortSignal): Iterable<unknown> {
  signal?.throwIfAborted()
  for (const record of records) {
    signal?.throwIfAborted()
    yield record
  }
  signal?.throwIfAborted()
}

function assertRefRow(
  row: CatalogRefRowV2,
  namespaceId: string,
  name: string,
  version: string,
): void {
  if (
    row.namespaceId !== namespaceId ||
    row.name !== name ||
    row.version !== version ||
    !EXACT_VERSION.test(row.version)
  ) {
    throw new IntegrityError('V2 Catalog returned an inconsistent ref row', {
      reason: 'ref_row_mismatch',
      expected_name: name,
      expected_version: version,
    })
  }
  catalogRefMetadata(row)
}

function catalogRefMetadata(row: CatalogRefRowV2): RefMetadataV2 {
  try {
    return RefMetadataV2Schema.parse(refMetadataFromCatalog(row))
  } catch (error) {
    throw new IntegrityError('Stored V2 ref metadata is inconsistent', {
      reason: 'catalog_ref_invalid',
      cause: error instanceof Error ? error.name : typeof error,
    })
  }
}

function validateCatalogRefPage(
  page: CatalogRefPageV2,
  namespaceId: string,
  afterName: string | null,
  limit: number,
): { readonly items: readonly RefMetadataV2[]; readonly nextName: string | null } {
  if (page.rows.length > limit) {
    throw new IntegrityError('V2 Catalog returned too many refs', {
      reason: 'catalog_ref_page_oversized',
      limit,
      actual: page.rows.length,
    })
  }
  const items: RefMetadataV2[] = []
  let previousName = afterName
  for (const row of page.rows) {
    if (row.namespaceId !== namespaceId || (previousName !== null && row.name <= previousName)) {
      throw new IntegrityError('V2 Catalog returned an invalid ref page order', {
        reason: 'catalog_ref_page_order',
      })
    }
    items.push(catalogRefMetadata(row))
    previousName = row.name
  }
  if (
    page.nextName !== null &&
    (page.rows.length !== limit || page.nextName !== page.rows.at(-1)?.name)
  ) {
    throw new IntegrityError('V2 Catalog returned an invalid ref continuation', {
      reason: 'catalog_ref_page_continuation',
    })
  }
  return Object.freeze({ items: Object.freeze(items), nextName: page.nextName })
}

function sameLayoutIdentity(
  left: Readonly<DatasetLayoutIdentityV2>,
  right: Readonly<DatasetLayoutIdentityV2>,
): boolean {
  return (
    left.identity_profile === right.identity_profile &&
    left.record_schema_version === right.record_schema_version &&
    left.dataset_version === right.dataset_version &&
    left.num_records === right.num_records &&
    left.layout_version === right.layout_version &&
    left.artifact_digest === right.artifact_digest &&
    left.artifact_size_bytes === right.artifact_size_bytes
  )
}

function registeredObjectMissing(
  identity: Readonly<DatasetLayoutIdentityV2>,
  reason: string,
  cause?: unknown,
): IntegrityError {
  const error = new IntegrityError('Registered V2 dataset objects are missing or unreadable', {
    reason,
    dataset_version: identity.dataset_version,
    layout_version: identity.layout_version,
    artifact_digest: identity.artifact_digest,
  })
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause })
  }
  return error
}

function snapshotDatasetLimits(limits: V2DatasetLimits): Readonly<V2DatasetLimits> {
  const values = {
    max_records: nonNegativeSafeInteger('max_records', limits.max_records),
    max_canonical_bytes: nonNegativeSafeInteger('max_canonical_bytes', limits.max_canonical_bytes),
    max_record_bytes: nonNegativeSafeInteger('max_record_bytes', limits.max_record_bytes),
  }
  return Object.freeze(values)
}

function assertIngestLimitsReadable(
  ingest: Readonly<V2DatasetLimits>,
  storeRead: Readonly<V2DatasetLimits>,
): void {
  if (
    ingest.max_records > storeRead.max_records ||
    ingest.max_canonical_bytes > storeRead.max_canonical_bytes ||
    ingest.max_record_bytes > storeRead.max_record_bytes
  ) {
    throw new TypeError('V2Workspace ingest limits cannot exceed Store read limits')
  }
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function checkedMultiply(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new TypeError('V2 cache capacity factors must be non-negative safe integers')
  }
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new TypeError('V2 cache capacity exceeds the safe integer range')
  }
  return left * right
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
