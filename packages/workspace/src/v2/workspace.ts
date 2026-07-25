import { parse as parsePath, resolve as resolvePath } from 'node:path'
import {
  type CatalogIdentityClaimInputV2,
  type CatalogIdentityClaimResultV2,
  type CatalogLayoutRowV2,
  type CatalogRefPageV2,
  type CatalogRefRowV2,
  type CatalogRunPageV2,
  type CatalogRunRowV2,
  type CatalogSnapshotRowV2,
  type CompareAndSetRefV2,
  type RegisterLayoutV2,
  type RegisterTransformResultV2,
  V2Catalog,
  V2CatalogDeterminismConflictError,
} from '@databench/catalog'
import {
  admitV2TransformWorkingSet,
  DEFAULT_V2_DATASET_LIMITS,
  V2Dataset,
  type V2DatasetLimits,
} from '@databench/engine'
import {
  canonicalJsonV2,
  createArtifactHasher,
  hashV2TransformCache,
  V2_EXPORT_FIDELITY_PROFILE,
  V2_IDENTITY_PROFILE,
} from '@databench/hashing'
import {
  createDefaultV2ConverterRegistry,
  DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2,
  readCanonicalJsonlV2,
  type V2ConverterRegistry,
} from '@databench/io'
import {
  BUILTIN_V2_TRANSFORM_REGISTRY,
  createV2TransformContext,
  type V2TransformDefinition,
  type V2TransformRegistry,
} from '@databench/ops'
import {
  type AddRecordsV2Options,
  AddRecordsV2OptionsSchema,
  type AuditResultV2,
  AuditResultV2Schema,
  assertExportFidelityAcceptedV2,
  CapacityExceededError,
  type ConverterAnalysisV2,
  type ConverterDescriptorV2,
  ConverterDescriptorV2Schema,
  type ConverterNameV2,
  ConverterNameV2Schema,
  type CursorPageRequestV2,
  CursorPageRequestV2Schema,
  createExportPlanV2,
  createPostTrainingV2Capability,
  createRecordSummaryV2,
  type DatasetLayoutIdentityV2,
  type DatasetLineageV2,
  DatasetLineageV2Schema,
  type DatasetViewV2,
  DatasetViewV2Schema,
  DEFAULT_RAW_JSON_LIMITS_V2,
  DEFAULT_TOOL_SCHEMA_LIMITS_V2,
  DeterminismConflictErrorV2,
  DigestHexV2Schema,
  datasetLayoutIdentityV2FromManifest,
  deriveRecordEligibilityV2,
  type ExportPlanV2,
  type ExportRequestV2,
  ExportRequestV2Schema,
  type IngestResultV2,
  IngestResultV2Schema,
  type InspectExportRequestV2,
  InspectExportRequestV2Schema,
  IntegrityError,
  type JsonObjectV2,
  type LineagePageRequestV2,
  LineagePageRequestV2Schema,
  MCP_MAX_PREVIEW_RECORDS,
  type McpCanonicalValidationPreviewResult,
  McpCanonicalValidationPreviewResultSchema,
  NotFoundError,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
  type PostTrainingV2Capability,
  type PostTrainingV2Limits,
  type PutRefRequestV2,
  PutRefRequestV2Schema,
  RecordIdV2Schema,
  type RecordPageRequestV2,
  RecordPageRequestV2Schema,
  type RecordPageV2,
  RecordPageV2Schema,
  type RecordRevisionV2,
  type RecordViewV2,
  RecordViewV2Schema,
  type RefMetadataV2,
  RefMetadataV2Schema,
  RefNameV2Schema,
  RefOrVersionV2Schema,
  type RefPageV2,
  RefPageV2Schema,
  ResourceLimitError,
  type RunMetadataV2,
  RunMetadataV2Schema,
  type RunTransformRequestV2,
  RunTransformRequestV2Schema,
  type RunTransformResultV2,
  RunTransformResultV2Schema,
  TransformCacheIdentityV1Schema,
  type TransformDescriptorV2,
  TransformDescriptorV2Schema,
  V2_LINEAGE_MAX_DEPTH,
  V2_LINEAGE_MAX_NODES,
  V2_RECORD_JSON_LAYOUT_VERSION,
  V2_TRANSFORM_MAX_INPUTS,
} from '@databench/schema'
import {
  type ConditionalObjectStoreV2,
  FileBackedV2Store,
  type OssConditionalClientV2,
  OssConditionalObjectStoreV2,
  type PreparedArtifactV2,
  S3ConditionalObjectStoreV2,
  type V2ObjectStoreConfig,
  type V2OperationContext,
  type V2Store,
  v2ObjectStoreConfigFromEnv,
} from '@databench/store'
import {
  V2DatasetCache,
  type V2DatasetCacheKey,
  type V2DatasetLease,
  v2DatasetCacheRequiredWeight,
} from './cache.js'
import { V2CursorCodec } from './cursor.js'
import { V2WorkspaceIdentityAllocator } from './identity-allocator.js'
import {
  layoutIdentityFromCatalog,
  manifestFromCatalogIdentity,
  mapV2CatalogError,
  refMetadataFromCatalog,
  registrationFromCommittedDataset,
} from './mappings.js'
import {
  DEFAULT_V2_TRANSFORM_CONCURRENCY,
  DEFAULT_V2_TRANSFORM_MAX_PENDING,
  V2TransformSemaphore,
} from './transform-semaphore.js'

const EXACT_VERSION = /^[0-9a-f]{64}$/
const DEFAULT_V2_CACHE_ENTRIES = 2
const DEFAULT_V2_TRANSFORM_WORKING_SET_MULTIPLIER = 4
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const claimedWorkspaceCaches = new WeakSet<V2DatasetCache>()
const V2_WORKSPACE_TEMP_DIRECTORY = '.databench-v2-temp'
const NO_ASYNC_OPTIONS_FAILURE = Symbol('no async V2 ingest options failure')

export interface V2WorkspaceCatalog {
  getOrCreateNamespace(scope: 'default'): Promise<string>
  insertOrReadIdentityClaim(
    input: CatalogIdentityClaimInputV2,
  ): Promise<CatalogIdentityClaimResultV2>
  registerCommittedLayout(input: RegisterLayoutV2): Promise<void>
  registerTransformResult(input: RegisterTransformResultV2): Promise<void>
  findRun(cacheKey: string): Promise<CatalogRunRowV2 | null>
  lineageSnapshotSequence(): Promise<bigint>
  listRunsProducing(
    version: string,
    afterCacheKey: string | null,
    limit: number,
    lineageSequenceAtOrBefore: bigint,
  ): Promise<CatalogRunPageV2>
  getSnapshot(version: string): Promise<CatalogSnapshotRowV2 | null>
  getLayout(version: string, layout: string): Promise<CatalogLayoutRowV2 | null>
  getRef(namespaceId: string, name: string): Promise<CatalogRefRowV2 | null>
  compareAndSetRef(input: CompareAndSetRefV2): Promise<CatalogRefRowV2>
  listRefs(namespaceId: string, afterName: string | null, limit: number): Promise<CatalogRefPageV2>
}

export interface V2WorkspaceOperationOptions extends V2OperationContext {}

export interface V2CanonicalJsonlPreviewOptions {
  readonly previewRecords?: number
  readonly maxResponseBytes: number
}

export interface V2TransformLimits {
  readonly max_input_datasets: number
  readonly max_working_set_bytes: number
  readonly max_concurrent_runs: number
  readonly max_pending_runs: number
}

export interface V2JsonlLimits {
  readonly max_request_bytes: number
  readonly max_nesting_depth: number
}

export type V2WorkspaceRuntimeLimits = PostTrainingV2Limits
export type PostTrainingV2RuntimeCapability = PostTrainingV2Capability

export interface PostTrainingV2CapabilityOptions {
  readonly datasetLimits?: V2DatasetLimits
  readonly transformLimits?: Partial<V2TransformLimits>
  readonly jsonlLimits?: Partial<V2JsonlLimits>
  readonly converterRegistry?: V2ConverterRegistry
}

export interface V2WorkspaceOptions {
  readonly catalog: V2WorkspaceCatalog
  readonly store: V2Store
  readonly cursorSecret: Uint8Array | string
  readonly cache?: V2DatasetCache
  readonly datasetLimits?: V2DatasetLimits
  readonly transformRegistry?: V2TransformRegistry
  readonly converterRegistry?: V2ConverterRegistry
  readonly transformLimits?: Partial<V2TransformLimits>
  readonly jsonlLimits?: Partial<V2JsonlLimits>
  readonly onCleanupError?: (error: unknown, primaryError: unknown | null) => void
}

export interface V2WorkspaceOpenOptions {
  readonly root?: string
  readonly databaseUrl?: string
  readonly storeConfig?: V2ObjectStoreConfig
  readonly cursorSecret: Uint8Array | string
  readonly datasetLimits?: V2DatasetLimits
  readonly transformLimits?: Partial<V2TransformLimits>
  readonly jsonlLimits?: Partial<V2JsonlLimits>
}

interface ResolvedLayoutV2 {
  readonly requestedRef: string
  readonly refName: string | null
  readonly identity: Readonly<DatasetLayoutIdentityV2>
}

export interface ExportStreamV2 {
  readonly plan: Readonly<ExportPlanV2>
  readonly bytes: AsyncIterable<Uint8Array>
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
  readonly #transformRegistry: V2TransformRegistry
  readonly #converterRegistry: V2ConverterRegistry
  readonly #transformLimits: Readonly<V2TransformLimits>
  readonly #jsonlLimits: Readonly<V2JsonlLimits>
  readonly #runtimeCapability: Readonly<PostTrainingV2RuntimeCapability>
  readonly #transformSemaphore: V2TransformSemaphore
  readonly #onCleanupError: ((error: unknown, primaryError: unknown | null) => void) | undefined
  #namespacePromise: Promise<string> | undefined
  #closeOwnedResources: (() => Promise<void>) | undefined
  #closePromise: Promise<void> | undefined

  static async open(optionsInput: V2WorkspaceOpenOptions): Promise<V2Workspace> {
    const options = snapshotV2WorkspaceOpenOptions(optionsInput)
    const catalog = new V2Catalog(
      options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
    )
    try {
      const objectStore = createConditionalObjectStoreV2(
        options.storeConfig ?? v2ObjectStoreConfigFromEnv(),
      )
      const store = new FileBackedV2Store({
        objectStore,
        tempRoot: v2WorkspaceTempRoot(options.root),
        ...(options.datasetLimits === undefined ? {} : { datasetLimits: options.datasetLimits }),
      })
      const workspace = new V2Workspace({
        catalog,
        store,
        cursorSecret: options.cursorSecret,
        ...(options.datasetLimits === undefined ? {} : { datasetLimits: options.datasetLimits }),
        ...(options.transformLimits === undefined
          ? {}
          : { transformLimits: options.transformLimits }),
        ...(options.jsonlLimits === undefined ? {} : { jsonlLimits: options.jsonlLimits }),
      })
      workspace.#closeOwnedResources = async () => {
        await catalog.close()
      }
      return workspace
    } catch (error) {
      try {
        await catalog.close()
      } catch (closeError) {
        attachSuppressed(error, closeError)
      }
      throw error
    }
  }

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
    this.#transformRegistry = options.transformRegistry ?? BUILTIN_V2_TRANSFORM_REGISTRY
    this.#converterRegistry = options.converterRegistry ?? createDefaultV2ConverterRegistry()
    this.#transformLimits = snapshotTransformLimits(
      options.transformLimits,
      this.#datasetLimits.max_canonical_bytes,
    )
    this.#jsonlLimits = snapshotJsonlLimits(options.jsonlLimits)
    this.#transformSemaphore = new V2TransformSemaphore({
      maxConcurrentRuns: this.#transformLimits.max_concurrent_runs,
      maxPendingRuns: this.#transformLimits.max_pending_runs,
    })
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
    this.#runtimeCapability = postTrainingV2Capability({
      datasetLimits: this.#datasetLimits,
      jsonlLimits: this.#jsonlLimits,
      transformLimits: this.#transformLimits,
      converterRegistry: this.#converterRegistry,
    })
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#closeOwnedResources?.() ?? Promise.resolve()
    return await this.#closePromise
  }

  postTrainingV2Capability(): Readonly<PostTrainingV2RuntimeCapability> {
    return this.#runtimeCapability
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
    optionsInput: AddRecordsV2Options | PromiseLike<AddRecordsV2Options>,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<IngestResultV2> {
    context.signal?.throwIfAborted()
    const internalAbort = new AbortController()
    const operationSignal =
      context.signal === undefined
        ? internalAbort.signal
        : AbortSignal.any([context.signal, internalAbort.signal])
    let optionsFailure: unknown = NO_ASYNC_OPTIONS_FAILURE
    const optionsPromise = Promise.resolve(optionsInput)
      .then((input) => AddRecordsV2OptionsSchema.parse(input))
      .catch((error: unknown) => {
        optionsFailure = error
        internalAbort.abort(error)
        throw error
      })
    // Observe an early rejection even while the JSONL reader is still between
    // chunks. The same promise is awaited below once the file part is consumed.
    void optionsPromise.catch(() => undefined)
    const records = readCanonicalJsonlV2(source, {
      limits: {
        maxBytes: this.#datasetLimits.max_record_bytes,
        maxDepth: this.#jsonlLimits.max_nesting_depth,
      },
      maxTransportBytes: this.#jsonlLimits.max_request_bytes,
      signal: operationSignal,
    })
    try {
      // Multipart text fields may follow the file part. Start consuming the
      // file before awaiting their Promise so field order cannot deadlock.
      const dataset = await V2Dataset.fromAsyncRecords(records, this.#datasetLimits, {
        signal: operationSignal,
      })
      const options = await awaitWithAbort(optionsPromise, context.signal)
      context.signal?.throwIfAborted()
      return await this.#publish(dataset, options, context.signal)
    } catch (error) {
      internalAbort.abort(error)
      if (optionsFailure !== NO_ASYNC_OPTIONS_FAILURE) throw optionsFailure
      throw error
    }
  }

  async previewCanonicalJsonl(
    source: AsyncIterable<Uint8Array>,
    optionsInput: V2CanonicalJsonlPreviewOptions,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<Readonly<McpCanonicalValidationPreviewResult>> {
    context.signal?.throwIfAborted()
    const options = snapshotCanonicalPreviewOptions(optionsInput)
    const hasher = createArtifactHasher()
    const previewRecordIds: string[] = []
    let recordCount = 0
    const operationOptions = operationContext(context.signal)
    const parsed = readCanonicalJsonlV2(hashCanonicalSource(source, hasher, context.signal), {
      limits: {
        maxBytes: this.#datasetLimits.max_record_bytes,
        maxDepth: this.#jsonlLimits.max_nesting_depth,
      },
      maxTransportBytes: this.#jsonlLimits.max_request_bytes,
      ...operationOptions,
    })
    const observed = observePreviewRecords(parsed, previewRecordIds, options.previewRecords, () => {
      recordCount += 1
    })

    const dataset = await V2Dataset.fromAsyncRecords(
      observed,
      this.#datasetLimits,
      operationOptions,
    )
    context.signal?.throwIfAborted()
    const records = previewRecordIds.map((recordId) => {
      const revision = dataset.get(recordId)
      if (revision === null) {
        throw new IntegrityError('Canonical preview record is missing from the validated dataset', {
          reason: 'canonical_preview_record_missing',
          record_id: recordId,
        })
      }
      return PostTrainingRecordV2Schema.parse(revision.record)
    })
    return fitCanonicalPreviewResult(
      {
        format: 'canonical-jsonl',
        input_digest: hasher.digestHex(),
        record_count: recordCount,
        records,
        records_truncated: false,
      },
      options.previewRecords,
      options.maxResponseBytes,
    )
  }

  listTransforms(): readonly Readonly<TransformDescriptorV2>[] {
    return Object.freeze(
      this.#transformRegistry
        .descriptors()
        .map((descriptor) => Object.freeze(TransformDescriptorV2Schema.parse(descriptor))),
    )
  }

  listConverters(): readonly Readonly<ConverterDescriptorV2>[] {
    return Object.freeze(
      this.#converterRegistry
        .descriptors()
        .map((descriptor) => deepFreeze(ConverterDescriptorV2Schema.parse(descriptor))),
    )
  }

  getConverter(nameInput: string): Readonly<ConverterDescriptorV2> | null {
    const name = ConverterNameV2Schema.safeParse(nameInput)
    if (!name.success) return null
    return this.listConverters().find((descriptor) => descriptor.name === name.data) ?? null
  }

  async inspectExport(
    refOrVersionInput: string,
    requestInput: InspectExportRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<Readonly<ExportPlanV2>> {
    context.signal?.throwIfAborted()
    const request = InspectExportRequestV2Schema.parse(requestInput)
    const resolved = await this.#resolveLayout(refOrVersionInput, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      context.signal?.throwIfAborted()
      return this.#createExportPlan(resolved.identity.dataset_version, lease.dataset, request).plan
    } finally {
      lease.release()
    }
  }

  async export(
    datasetVersionInput: string,
    requestInput: ExportRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<ExportStreamV2> {
    context.signal?.throwIfAborted()
    const datasetVersion = requireExactDatasetVersion(datasetVersionInput)
    const request = ExportRequestV2Schema.parse(requestInput)
    const resolved = await this.#resolveLayout(datasetVersion, context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    try {
      context.signal?.throwIfAborted()
      const inspected = this.#createExportPlan(datasetVersion, lease.dataset, request)
      assertExportFidelityAcceptedV2(inspected.plan, request.accepted_fidelity_digest)
      context.signal?.throwIfAborted()
      lease.release()
      return Object.freeze({
        plan: inspected.plan,
        bytes: singleUseLazyExportStream(async () => {
          const streamLease = await this.#acquire(resolved.identity, context.signal)
          try {
            context.signal?.throwIfAborted()
            if (streamLease.dataset.version !== datasetVersion) {
              throw new IntegrityError('Loaded V2 dataset does not match the export stream', {
                reason: 'export_stream_dataset_version_mismatch',
                expected_dataset_version: datasetVersion,
                actual_dataset_version: streamLease.dataset.version,
              })
            }
            const source = this.#converterRegistry.stream(
              request.converter,
              stableConverterRecords(streamLease.dataset),
              inspected.analysis.normalized_options,
              inspected.analysis,
            )
            return { source, lease: streamLease }
          } catch (error) {
            streamLease.release()
            throw error
          }
        }, context.signal),
      })
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async runTransform(
    name: string,
    requestInput: RunTransformRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RunTransformResultV2> {
    context.signal?.throwIfAborted()
    const request = RunTransformRequestV2Schema.parse(requestInput)
    if (request.inputs.length > this.#transformLimits.max_input_datasets) {
      throw new CapacityExceededError('V2 transform has too many input datasets', {
        resource: 'v2_transform_input_datasets',
        limit: this.#transformLimits.max_input_datasets,
        actual: request.inputs.length,
      })
    }
    const definition = this.#transformRegistry.require(name)
    const params = this.#transformRegistry.parseParams(name, request.params)
    const resolvedInputs: ResolvedLayoutV2[] = []
    const leases: V2DatasetLease[] = []
    let started = false
    try {
      for (const input of request.inputs) {
        context.signal?.throwIfAborted()
        const resolved = await this.#resolveLayout(input, context.signal)
        const lease = await this.#acquire(resolved.identity, context.signal)
        resolvedInputs.push(resolved)
        leases.push(lease)
      }
      const datasets = Object.freeze(leases.map(({ dataset }) => dataset))
      const estimate = definition.estimateWorkingSet(datasets, params, this.#datasetLimits)
      admitV2TransformWorkingSet(
        {
          inputDatasets: datasets,
          outputUpperBoundBytes: estimate.outputUpperBoundBytes,
          frameEstimateBytes: estimate.frameEstimateBytes,
        },
        this.#transformLimits.max_working_set_bytes,
      )

      return await this.#transformSemaphore.run(async (runSignal) => {
        started = true
        try {
          return await this.#executeTransform(
            definition,
            params,
            resolvedInputs,
            datasets,
            request,
            estimate.outputUpperBoundBytes,
            runSignal,
          )
        } finally {
          releaseLeases(leases)
        }
      }, context.signal)
    } catch (error) {
      if (!started) releaseLeases(leases)
      throw error
    }
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

  async lineage(
    refOrVersionInput: string,
    requestInput: LineagePageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<DatasetLineageV2> {
    context.signal?.throwIfAborted()
    const requestedRef = RefOrVersionV2Schema.parse(refOrVersionInput)
    const request = LineagePageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const initialState =
      request.cursor === null
        ? await this.#newLineageState(requestedRef, request, context.signal)
        : this.#cursor.decodeLineage(
            request.cursor,
            namespaceId,
            requestedRef,
            request.max_depth,
            request.max_nodes,
          )
    const frontier = [{ dataset_version: initialState.root_dataset_version, depth: 0 }]
    const known = new Set([initialState.root_dataset_version])
    const nodes: DatasetLineageV2['nodes'][number][] = []
    const edges: DatasetLineageV2['edges'][number][] = []
    const snapshotSequence = BigInt(initialState.snapshot_sequence)
    let traversedNodes = 0
    let traversedEdges = 0
    let truncated = false

    while (frontier.length > 0) {
      context.signal?.throwIfAborted()
      const current = frontier.shift()
      if (!current) break
      if (traversedNodes >= initialState.emitted_nodes) {
        if (nodes.length >= request.max_nodes) {
          truncated = true
          break
        }
        const view = await this.describeDataset(current.dataset_version, context)
        nodes.push({ dataset_version: current.dataset_version, manifest: view.manifest })
      }
      traversedNodes += 1

      let afterCacheKey: string | null = null
      while (true) {
        const page = await this.#listProducingRuns(
          current.dataset_version,
          afterCacheKey,
          V2_LINEAGE_MAX_NODES,
          snapshotSequence,
          context.signal,
        )
        const pageRows = validateCatalogRunPage(
          page,
          current.dataset_version,
          afterCacheKey,
          V2_LINEAGE_MAX_NODES,
          snapshotSequence,
        )
        for (const run of pageRows) {
          if (traversedEdges >= V2_LINEAGE_MAX_NODES) {
            throw new CapacityExceededError('V2 lineage run state exceeds its bounded capacity', {
              resource: 'v2_lineage_state_runs',
              limit: V2_LINEAGE_MAX_NODES,
              actual: traversedEdges + 1,
            })
          }
          if (traversedEdges >= initialState.emitted_edges && edges.length >= request.max_nodes) {
            truncated = true
            break
          }
          const edge = lineageEdgeFromRun(run, current.dataset_version)
          if (traversedEdges >= initialState.emitted_edges) edges.push(edge)
          traversedEdges += 1
          if (current.depth >= request.max_depth) continue
          for (const inputVersion of edge.input_dataset_versions) {
            if (known.has(inputVersion)) continue
            if (known.size >= V2_LINEAGE_MAX_NODES) {
              throw new CapacityExceededError('V2 lineage frontier exceeds its bounded capacity', {
                resource: 'v2_lineage_state_nodes',
                limit: V2_LINEAGE_MAX_NODES,
                actual: known.size + 1,
              })
            }
            known.add(inputVersion)
            frontier.push({ dataset_version: inputVersion, depth: current.depth + 1 })
          }
        }
        if (truncated) break
        if (page.nextCacheKey === null) break
        if (traversedEdges >= V2_LINEAGE_MAX_NODES) {
          throw new CapacityExceededError('V2 lineage run state exceeds its bounded capacity', {
            resource: 'v2_lineage_state_runs',
            limit: V2_LINEAGE_MAX_NODES,
            actual: traversedEdges + 1,
          })
        }
        afterCacheKey = page.nextCacheKey
      }
      if (truncated) break
      if (
        (nodes.length >= request.max_nodes || edges.length >= request.max_nodes) &&
        frontier.length > 0
      ) {
        truncated = true
        break
      }
    }

    if (
      !truncated &&
      (traversedNodes < initialState.emitted_nodes || traversedEdges < initialState.emitted_edges)
    ) {
      throw new IntegrityError('V2 lineage snapshot replay no longer reaches its cursor position', {
        reason: 'lineage_snapshot_replay_mismatch',
      })
    }

    const nextCursor = truncated
      ? this.#cursor.encodeLineage(namespaceId, requestedRef, {
          root_dataset_version: initialState.root_dataset_version,
          snapshot_sequence: initialState.snapshot_sequence,
          max_depth: request.max_depth,
          max_nodes: request.max_nodes,
          emitted_nodes: initialState.emitted_nodes + nodes.length,
          emitted_edges: initialState.emitted_edges + edges.length,
        })
      : null
    return DatasetLineageV2Schema.parse({
      root_dataset_version: initialState.root_dataset_version,
      nodes,
      edges,
      truncated,
      next_cursor: nextCursor,
    })
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

  #createExportPlan(
    datasetVersion: string,
    dataset: V2Dataset,
    request: Pick<InspectExportRequestV2, 'converter' | 'options'>,
  ): {
    readonly plan: Readonly<ExportPlanV2>
    readonly analysis: Readonly<ConverterAnalysisV2>
  } {
    if (dataset.version !== datasetVersion) {
      throw new IntegrityError('Loaded V2 dataset does not match the export target', {
        reason: 'export_dataset_version_mismatch',
        expected_dataset_version: datasetVersion,
        actual_dataset_version: dataset.version,
      })
    }
    const converter = this.#converterRegistry.require(request.converter)
    const records = stableConverterRecords(dataset)
    const analysis = deepFreeze(
      this.#converterRegistry.inspect(request.converter, records, request.options),
    )
    const plan = deepFreeze(
      createExportPlanV2({
        export_fidelity_profile: V2_EXPORT_FIDELITY_PROFILE,
        dataset_version: datasetVersion,
        converter: request.converter,
        converter_version: converter.version,
        normalized_options: analysis.normalized_options,
        media_type: analysis.media_type,
        suggested_filename: analysis.suggested_filename,
        output_count: analysis.output_count,
        config_hints: analysis.config_hints,
        fidelity: analysis.fidelity,
      }),
    )
    return Object.freeze({ plan, analysis })
  }

  async #executeTransform(
    definition: V2TransformDefinition,
    params: JsonObjectV2,
    resolvedInputs: readonly ResolvedLayoutV2[],
    datasets: readonly V2Dataset[],
    request: RunTransformRequestV2,
    outputUpperBoundBytes: number,
    signal: AbortSignal,
  ): Promise<RunTransformResultV2> {
    signal.throwIfAborted()
    const inputVersions = Object.freeze(
      resolvedInputs.map(({ identity }) => identity.dataset_version),
    )
    const cacheIdentity = TransformCacheIdentityV1Schema.parse({
      identity_profile: V2_IDENTITY_PROFILE,
      op: definition.name,
      op_version: definition.version,
      input_dataset_versions: inputVersions,
      params,
    })
    const cacheKey = hashV2TransformCache(cacheIdentity)
    const runId = `run_${cacheKey}` as const
    const cached = await this.#findRun(cacheKey, signal, true)
    if (cached !== null) {
      const run = validateRunRow(cached, {
        cacheKey,
        runId,
        op: definition.name,
        opVersion: definition.version,
        inputVersions,
        params,
      })
      const manifest = await this.#verifyTransformOutput(run.output_dataset_version, signal)
      const refUpdate = await this.#updateRefForCommittedDataset(
        run.output_dataset_version,
        request,
        signal,
      )
      return RunTransformResultV2Schema.parse({
        run,
        manifest,
        ref_update: refUpdate,
        cache_hit: true,
      })
    }

    const namespaceId = await this.#namespace(signal, true)
    const identityAllocator = new V2WorkspaceIdentityAllocator(
      this.#catalog,
      namespaceId,
      datasets,
      signal,
    )
    const seed = definition.rngSeed(params)
    const transformContext = createV2TransformContext({
      run_id: runId,
      identity_allocator: identityAllocator,
      seed,
      limits: this.#datasetLimits,
      working_set_budget_bytes: this.#transformLimits.max_working_set_bytes,
      signal,
    })
    const output = await definition.run(datasets, params, transformContext)
    signal.throwIfAborted()
    if (!(output instanceof V2Dataset)) {
      throw new IntegrityError('V2 transform returned a non-dataset output', {
        reason: 'transform_output_type',
        operation: definition.name,
      })
    }
    if (output.canonicalBytes > outputUpperBoundBytes) {
      throw new IntegrityError('V2 transform output exceeded its declared upper bound', {
        reason: 'transform_output_exceeds_estimate',
        operation: definition.name,
        declared_bytes: outputUpperBoundBytes,
        actual_bytes: output.canonicalBytes,
      })
    }
    const published = await this.#publishTransform(
      output,
      {
        id: runId,
        cacheKey,
        op: definition.name,
        opVersion: definition.version,
        params,
        inputVersions,
        outputVersion: output.version,
      },
      request,
      signal,
    )
    const winning = await this.#findRun(cacheKey, signal, true)
    if (winning === null) {
      throw new IntegrityError('Registered V2 transform run cannot be read back', {
        reason: 'transform_run_missing_after_register',
        cache_key: cacheKey,
      })
    }
    const run = validateRunRow(winning, {
      cacheKey,
      runId,
      op: definition.name,
      opVersion: definition.version,
      inputVersions,
      params,
      outputVersion: output.version,
    })
    return RunTransformResultV2Schema.parse({
      run,
      manifest: published.manifest,
      ref_update: published.refUpdate,
      cache_hit: false,
    })
  }

  async #newLineageState(
    requestedRef: string,
    request: LineagePageRequestV2,
    signal?: AbortSignal,
  ) {
    const resolved = await this.#resolveLayout(requestedRef, signal)
    const snapshotSequence = await this.#lineageSnapshotSequence(signal)
    return Object.freeze({
      root_dataset_version: resolved.identity.dataset_version,
      snapshot_sequence: snapshotSequence.toString(),
      max_depth: request.max_depth,
      max_nodes: request.max_nodes,
      emitted_nodes: 0,
      emitted_edges: 0,
    })
  }

  async #lineageSnapshotSequence(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted()
    try {
      const snapshotSequence = await waitWithAbort(this.#catalog.lineageSnapshotSequence(), signal)
      if (
        typeof snapshotSequence !== 'bigint' ||
        snapshotSequence < 0n ||
        snapshotSequence > POSTGRES_BIGINT_MAX
      ) {
        throw new IntegrityError('V2 Catalog returned an invalid lineage snapshot sequence', {
          reason: 'catalog_lineage_snapshot_sequence_invalid',
        })
      }
      return snapshotSequence
    } catch (error) {
      if (signal?.aborted || error instanceof IntegrityError) throw error
      mapV2CatalogError(error, false)
    }
  }

  async #listProducingRuns(
    datasetVersion: string,
    afterCacheKey: string | null,
    limit: number,
    lineageSequenceAtOrBefore: bigint,
    signal?: AbortSignal,
  ): Promise<CatalogRunPageV2> {
    signal?.throwIfAborted()
    try {
      return await waitWithAbort(
        this.#catalog.listRunsProducing(
          datasetVersion,
          afterCacheKey,
          limit,
          lineageSequenceAtOrBefore,
        ),
        signal,
      )
    } catch (error) {
      if (signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
  }

  async #findRun(
    cacheKey: string,
    signal?: AbortSignal,
    settleOnAbort = false,
  ): Promise<CatalogRunRowV2 | null> {
    signal?.throwIfAborted()
    try {
      const row = settleOnAbort
        ? await this.#catalog.findRun(cacheKey)
        : await waitWithAbort(this.#catalog.findRun(cacheKey), signal)
      signal?.throwIfAborted()
      return row
    } catch (error) {
      if (signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
  }

  async #verifyTransformOutput(datasetVersion: string, signal: AbortSignal) {
    let resolved: ResolvedLayoutV2
    try {
      resolved = await this.#resolveLayout(datasetVersion, signal, true)
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new IntegrityError('Cached V2 transform output is not registered', {
          reason: 'transform_cache_output_missing',
          dataset_version: datasetVersion,
        })
      }
      throw error
    }
    const lease = await this.#acquire(resolved.identity, signal, true)
    try {
      signal.throwIfAborted()
      if (lease.dataset.version !== datasetVersion) {
        throw new IntegrityError('Cached V2 transform output resolved to a different dataset', {
          reason: 'transform_cache_output_mismatch',
          expected_dataset_version: datasetVersion,
          actual_dataset_version: lease.dataset.version,
        })
      }
      return manifestFromCatalogIdentity(resolved.identity)
    } finally {
      lease.release()
    }
  }

  async #publishTransform(
    dataset: V2Dataset,
    run: RegisterTransformResultV2['run'],
    request: RunTransformRequestV2,
    signal: AbortSignal,
  ) {
    let prepared: PreparedArtifactV2 | undefined
    let result:
      | {
          readonly manifest: ReturnType<typeof manifestFromCatalogIdentity>
          readonly refUpdate: RunTransformResultV2['ref_update']
        }
      | undefined
    let failed = false
    let failure: unknown
    try {
      signal.throwIfAborted()
      prepared = await this.#store.prepare(dataset, { signal })
      const manifest = await this.#store.commit(prepared, { signal })
      const registration = registrationFromCommittedDataset(dataset, manifest)
      try {
        await this.#catalog.registerTransformResult({ ...registration, run })
      } catch (error) {
        if (error instanceof V2CatalogDeterminismConflictError) {
          // The read-after-conflict is still a Catalog dependency call. Route
          // it through the same abort and typed error mapping boundary as an
          // ordinary cache lookup instead of leaking a raw driver error.
          const existing = await this.#findRun(run.cacheKey, signal, true)
          if (existing === null) {
            throw new IntegrityError('V2 transform conflict has no winning run', {
              reason: 'transform_conflict_without_winner',
              cache_key: run.cacheKey,
            })
          }
          const existingRun = validateRunRow(existing, {
            cacheKey: run.cacheKey,
            runId: run.id,
            op: run.op,
            opVersion: run.opVersion,
            inputVersions: run.inputVersions,
            params: run.params,
          })
          if (existingRun.output_dataset_version === run.outputVersion) {
            throw new IntegrityError(
              'V2 Catalog reported a conflict for an identical transform run',
              {
                reason: 'transform_conflict_for_identical_run',
                cache_key: run.cacheKey,
              },
            )
          }
          throw new DeterminismConflictErrorV2({
            cache_key: run.cacheKey,
            existing_output_version: existingRun.output_dataset_version,
            attempted_output_version: run.outputVersion,
            attempted_dataset_committed: true,
          })
        }
        mapV2CatalogError(error, true)
      }
      const refUpdate = await this.#updateRefForCommittedDataset(dataset.version, request, signal)
      result = { manifest, refUpdate }
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
      throw new IntegrityError('V2 transform publish completed without a result', {
        reason: 'transform_publish_result_missing',
      })
    }
    return result
  }

  async #updateRefForCommittedDataset(
    datasetVersion: string,
    request: Pick<RunTransformRequestV2, 'ref' | 'expected_ref_version' | 'message'>,
    signal: AbortSignal,
  ): Promise<RunTransformResultV2['ref_update']> {
    if (request.ref === null) return { status: 'not_requested' }
    const namespaceId = await this.#namespace(signal, true)
    signal.throwIfAborted()
    let ref: CatalogRefRowV2
    try {
      ref = await this.#catalog.compareAndSetRef({
        namespaceId,
        name: request.ref,
        newVersion: datasetVersion,
        expectedVersion: request.expected_ref_version,
        message: request.message,
      })
    } catch (error) {
      mapV2CatalogError(error, true)
    }
    assertRefRow(ref, namespaceId, request.ref, datasetVersion)
    return {
      status: 'updated',
      ref_name: ref.name,
      previous_version: request.expected_ref_version,
      current_version: ref.version,
    }
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

  async #resolveLayout(
    refOrVersionInput: string,
    signal?: AbortSignal,
    settleOnAbort = false,
  ): Promise<ResolvedLayoutV2> {
    signal?.throwIfAborted()
    const requestedRef = RefOrVersionV2Schema.parse(refOrVersionInput)
    let version: string
    let refName: string | null
    if (EXACT_VERSION.test(requestedRef)) {
      version = requestedRef
      refName = null
    } else {
      const namespaceId = await this.#namespace(signal, settleOnAbort)
      signal?.throwIfAborted()
      let ref: CatalogRefRowV2 | null
      try {
        ref = settleOnAbort
          ? await this.#catalog.getRef(namespaceId, requestedRef)
          : await waitWithAbort(this.#catalog.getRef(namespaceId, requestedRef), signal)
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
      const pending = Promise.all([
        this.#catalog.getSnapshot(version),
        this.#catalog.getLayout(version, V2_RECORD_JSON_LAYOUT_VERSION),
      ])
      ;[snapshot, layout] = settleOnAbort ? await pending : await waitWithAbort(pending, signal)
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
    settleOnAbort = false,
  ): Promise<V2DatasetLease> {
    try {
      return await this.#cache.acquire(
        cacheKey(identity),
        async (loadSignal) => await this.#store.read(identity, { signal: loadSignal }),
        {
          ...(signal === undefined ? {} : { signal }),
          ...(settleOnAbort ? { settleOnAbort: true } : {}),
        },
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

  async #namespace(signal?: AbortSignal, settleOnAbort = false): Promise<string> {
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
      namespaceId = settleOnAbort ? await pending : await waitWithAbort(pending, signal)
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

function requireExactDatasetVersion(input: string): string {
  return DigestHexV2Schema.parse(input)
}

function stableConverterRecords(dataset: V2Dataset): readonly RecordRevisionV2[] {
  const records = [...dataset.records()]
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]
    const current = records[index]
    if (previous && current && compareConverterRevisions(previous, current) >= 0) {
      throw new IntegrityError('V2 dataset records are not strictly converter-sorted', {
        reason: 'converter_record_order_invalid',
        dataset_version: dataset.version,
      })
    }
  }
  return Object.freeze(records)
}

function compareConverterRevisions(left: RecordRevisionV2, right: RecordRevisionV2): number {
  if (left.record_digest < right.record_digest) return -1
  if (left.record_digest > right.record_digest) return 1
  if (left.record.id < right.record.id) return -1
  if (left.record.id > right.record.id) return 1
  return 0
}

function singleUseLazyExportStream(
  open: () => Promise<{
    readonly source: AsyncIterable<Uint8Array>
    readonly lease: V2DatasetLease
  }>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let consumed = false
  const consume = async function* (): AsyncIterableIterator<Uint8Array> {
    let lease: V2DatasetLease | undefined
    let sourceIterator: AsyncIterator<Uint8Array> | undefined
    let inFlightNext: Promise<void> | undefined
    let abortClose: Promise<void> | undefined
    let primaryError: unknown
    let hasPrimaryError = false
    let cleanupError: unknown
    let hasCleanupError = false
    const closeOnAbort = (): void => {
      if (abortClose !== undefined) return
      const iteratorToClose = sourceIterator
      const nextToSettle = inFlightNext
      abortClose = Promise.resolve()
        .then(async () => {
          const closeResult = await Promise.resolve()
            .then(async () => {
              await iteratorToClose?.return?.()
            })
            .then(
              () => ({ failed: false as const }),
              (error: unknown) => ({ failed: true as const, error }),
            )
          // AsyncIterator.return() is optional and custom implementations may
          // resolve it before an already-running next(). Do not release the
          // cache pin until that work settles; otherwise a canceled converter
          // can retain this dataset while the cache admits another full one.
          await nextToSettle?.then(
            () => undefined,
            () => undefined,
          )
          if (closeResult.failed) throw closeResult.error
        })
        .finally(() => {
          const currentLease = lease
          lease = undefined
          sourceIterator = undefined
          currentLease?.release()
        })
      // The generator's finally observes the original promise when the caller
      // resumes. This handler only prevents an abandoned response stream from
      // creating an unhandled rejection after client disconnect.
      void abortClose.catch(() => undefined)
    }
    try {
      signal?.throwIfAborted()
      let opened:
        | {
            readonly source: AsyncIterable<Uint8Array>
            readonly lease: V2DatasetLease
          }
        | undefined = await open()
      lease = opened.lease
      sourceIterator = opened.source[Symbol.asyncIterator]()
      opened = undefined
      signal?.addEventListener('abort', closeOnAbort, { once: true })
      while (true) {
        signal?.throwIfAborted()
        let settleNext = (): void => undefined
        const nextSettlement = new Promise<void>((resolve) => {
          settleNext = resolve
        })
        // Install the fence before calling next(): a custom iterator can
        // synchronously trigger the caller's AbortController from next().
        inFlightNext = nextSettlement
        let result: IteratorResult<Uint8Array>
        try {
          result = await sourceIterator.next()
        } finally {
          settleNext()
          if (inFlightNext === nextSettlement) inFlightNext = undefined
        }
        signal?.throwIfAborted()
        if (result.done) break
        const chunk = result.value
        if (!(chunk instanceof Uint8Array)) {
          throw new IntegrityError('V2 converter stream yielded an invalid byte chunk', {
            reason: 'converter_stream_chunk_type',
          })
        }
        yield chunk
        signal?.throwIfAborted()
      }
    } catch (error) {
      hasPrimaryError = true
      primaryError = error
      throw error
    } finally {
      signal?.removeEventListener('abort', closeOnAbort)
      try {
        try {
          if (abortClose !== undefined) {
            await abortClose
          } else if (sourceIterator?.return !== undefined) {
            await sourceIterator.return()
          }
        } catch (error) {
          if (hasPrimaryError) {
            attachSuppressed(primaryError, error)
          } else {
            hasCleanupError = true
            cleanupError = error
          }
        }
      } finally {
        const currentLease = lease
        lease = undefined
        sourceIterator = undefined
        currentLease?.release()
      }
    }
    if (hasCleanupError) throw cleanupError
  }
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (consumed) {
        throw new TypeError('V2 export byte stream can only be consumed once')
      }
      consumed = true
      return consume()
    },
  })
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
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

function validateCatalogRunPage(
  page: CatalogRunPageV2,
  outputVersion: string,
  afterCacheKey: string | null,
  limit: number,
  lineageSequenceAtOrBefore: bigint,
): readonly CatalogRunRowV2[] {
  if (page.rows.length > limit) {
    throw new IntegrityError('V2 Catalog returned too many producing runs', {
      reason: 'catalog_run_page_oversized',
      limit,
      actual: page.rows.length,
    })
  }
  let previous = afterCacheKey
  for (const row of page.rows) {
    if (
      row.outputVersion !== outputVersion ||
      !EXACT_VERSION.test(row.cacheKey) ||
      typeof row.lineageSequence !== 'bigint' ||
      row.lineageSequence <= 0n ||
      row.lineageSequence > lineageSequenceAtOrBefore ||
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      (previous !== null && row.cacheKey <= previous)
    ) {
      throw new IntegrityError('V2 Catalog returned an invalid producing-run page', {
        reason: 'catalog_run_page_order',
        output_dataset_version: outputVersion,
      })
    }
    previous = row.cacheKey
  }
  if (
    page.nextCacheKey !== null &&
    (page.rows.length !== limit || page.nextCacheKey !== page.rows.at(-1)?.cacheKey)
  ) {
    throw new IntegrityError('V2 Catalog returned an invalid producing-run continuation', {
      reason: 'catalog_run_page_continuation',
    })
  }
  return page.rows
}

function lineageEdgeFromRun(
  row: CatalogRunRowV2,
  outputVersion: string,
): DatasetLineageV2['edges'][number] {
  try {
    const run = RunMetadataV2Schema.parse({
      run_id: row.id,
      cache_key: row.cacheKey,
      op: row.op,
      op_version: row.opVersion,
      input_dataset_versions: row.inputVersions,
      normalized_params: row.params,
      output_dataset_version: row.outputVersion,
      created_at: row.createdAt.toISOString(),
    })
    if (run.output_dataset_version !== outputVersion) {
      throw new Error('producing run output mismatch')
    }
    return {
      run_id: run.run_id,
      input_dataset_versions: run.input_dataset_versions,
      output_dataset_version: run.output_dataset_version,
    }
  } catch (error) {
    throw new IntegrityError('Stored V2 producing-run metadata is inconsistent', {
      reason: 'catalog_lineage_run_invalid',
      output_dataset_version: outputVersion,
      cause: error instanceof Error ? error.name : typeof error,
    })
  }
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

function snapshotCanonicalPreviewOptions(
  input: V2CanonicalJsonlPreviewOptions,
): Readonly<Required<V2CanonicalJsonlPreviewOptions>> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Canonical JSONL preview options must be an object')
  }
  const previewRecords = input.previewRecords ?? 3
  if (
    !Number.isSafeInteger(previewRecords) ||
    previewRecords < 0 ||
    previewRecords > MCP_MAX_PREVIEW_RECORDS
  ) {
    throw new TypeError(
      `Canonical JSONL previewRecords must be between 0 and ${MCP_MAX_PREVIEW_RECORDS}`,
    )
  }
  if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes <= 0) {
    throw new TypeError('Canonical JSONL maxResponseBytes must be a positive safe integer')
  }
  return Object.freeze({ previewRecords, maxResponseBytes: input.maxResponseBytes })
}

async function* hashCanonicalSource(
  source: AsyncIterable<Uint8Array>,
  hasher: ReturnType<typeof createArtifactHasher>,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<Uint8Array> {
  signal?.throwIfAborted()
  for await (const chunk of source) {
    signal?.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Canonical JSONL source must yield Uint8Array chunks')
    }
    hasher.update(chunk)
    yield chunk
    signal?.throwIfAborted()
  }
}

async function* observePreviewRecords(
  source: AsyncIterable<PostTrainingRecordV2>,
  recordIds: string[],
  limit: number,
  onRecord: () => void,
): AsyncIterableIterator<PostTrainingRecordV2> {
  for await (const record of source) {
    onRecord()
    if (recordIds.length < limit) recordIds.push(record.id)
    yield record
  }
}

function fitCanonicalPreviewResult(
  input: McpCanonicalValidationPreviewResult,
  requestedRecords: number,
  maxResponseBytes: number,
): Readonly<McpCanonicalValidationPreviewResult> {
  const records = [...input.records]
  while (true) {
    const result = McpCanonicalValidationPreviewResultSchema.parse({
      ...input,
      records,
      records_truncated: records.length < Math.min(input.record_count, requestedRecords),
    })
    // This JSON is transport sizing only. Identity serialization remains exclusively
    // owned by @databench/hashing.
    const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    if (responseBytes <= maxResponseBytes) return deepFreeze(result)
    if (records.length === 0) {
      throw new ResourceLimitError('Canonical preview exceeds the response byte limit', {
        resource: 'preview_response_bytes',
        limit: maxResponseBytes,
        actual: responseBytes,
      })
    }
    records.pop()
  }
}

export function postTrainingV2Capability(
  options: PostTrainingV2CapabilityOptions = {},
): Readonly<PostTrainingV2RuntimeCapability> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('V2 capability options must be an object')
  }
  const datasetLimits = snapshotDatasetLimits(options.datasetLimits ?? DEFAULT_V2_DATASET_LIMITS)
  const jsonlLimits = snapshotJsonlLimits(options.jsonlLimits)
  const transformLimits = snapshotTransformLimits(
    options.transformLimits,
    datasetLimits.max_canonical_bytes,
  )
  const converterRegistry = options.converterRegistry ?? createDefaultV2ConverterRegistry()
  return runtimeCapability(
    datasetLimits,
    jsonlLimits,
    transformLimits,
    converterRegistry.descriptors().map(({ name }) => name),
  )
}

export function v2WorkspaceTempRoot(root = './bench'): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('V2 Workspace root must be a non-empty path')
  }
  const absoluteRoot = resolvePath(root)
  if (absoluteRoot === parsePath(absoluteRoot).root) {
    throw new TypeError('V2 Workspace root must not be the filesystem root')
  }
  return resolvePath(absoluteRoot, V2_WORKSPACE_TEMP_DIRECTORY)
}

function snapshotV2WorkspaceOpenOptions(
  input: V2WorkspaceOpenOptions,
): Readonly<V2WorkspaceOpenOptions> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('V2Workspace open options must be an object')
  }
  if (input.root !== undefined) v2WorkspaceTempRoot(input.root)
  if (
    input.databaseUrl !== undefined &&
    (typeof input.databaseUrl !== 'string' || input.databaseUrl.length === 0)
  ) {
    throw new TypeError('V2Workspace databaseUrl must be a non-empty string')
  }
  if (
    input.storeConfig !== undefined &&
    (input.storeConfig === null || typeof input.storeConfig !== 'object')
  ) {
    throw new TypeError('V2Workspace storeConfig must be an object')
  }
  return Object.freeze({
    cursorSecret: input.cursorSecret,
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.databaseUrl === undefined ? {} : { databaseUrl: input.databaseUrl }),
    ...(input.storeConfig === undefined ? {} : { storeConfig: input.storeConfig }),
    ...(input.datasetLimits === undefined ? {} : { datasetLimits: input.datasetLimits }),
    ...(input.transformLimits === undefined ? {} : { transformLimits: input.transformLimits }),
    ...(input.jsonlLimits === undefined ? {} : { jsonlLimits: input.jsonlLimits }),
  })
}

function createConditionalObjectStoreV2(config: V2ObjectStoreConfig): ConditionalObjectStoreV2 {
  if (config.kind === 's3') {
    return new S3ConditionalObjectStoreV2({
      bucket: config.bucket,
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.accessKeyId === undefined ? {} : { accessKeyId: config.accessKeyId }),
      ...(config.secretAccessKey === undefined ? {} : { secretAccessKey: config.secretAccessKey }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.client === undefined ? {} : { client: config.client }),
    })
  }

  const client =
    config.client === undefined ? undefined : requireOssConditionalClientV2(config.client)
  return new OssConditionalObjectStoreV2({
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.secure === undefined ? {} : { secure: config.secure }),
    ...(config.internal === undefined ? {} : { internal: config.internal }),
    ...(client === undefined ? {} : { client }),
  })
}

function requireOssConditionalClientV2(client: unknown): OssConditionalClientV2 {
  if (
    typeof client !== 'object' ||
    client === null ||
    !hasFunction(client, 'putStream') ||
    !hasFunction(client, 'get') ||
    !hasFunction(client, 'getObjectMeta') ||
    !hasFunction(client, 'getBucketInfo')
  ) {
    throw new TypeError(
      'Injected OSS client must implement the V2 conditional object-store methods',
    )
  }
  return client as OssConditionalClientV2
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function snapshotJsonlLimits(input: Partial<V2JsonlLimits> | undefined): Readonly<V2JsonlLimits> {
  if (input !== undefined && (input === null || typeof input !== 'object')) {
    throw new TypeError('V2 JSONL limits must be an object')
  }
  return Object.freeze({
    max_request_bytes: nonNegativeSafeInteger(
      'max_request_bytes',
      input?.max_request_bytes ?? DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2,
    ),
    max_nesting_depth: nonNegativeSafeInteger(
      'max_nesting_depth',
      input?.max_nesting_depth ?? DEFAULT_RAW_JSON_LIMITS_V2.maxDepth,
    ),
  })
}

function runtimeCapability(
  datasetLimits: Readonly<V2DatasetLimits>,
  jsonlLimits: Readonly<V2JsonlLimits>,
  transformLimits: Readonly<V2TransformLimits>,
  converterNames: readonly ConverterNameV2[],
): PostTrainingV2RuntimeCapability {
  return deepFreeze(
    createPostTrainingV2Capability({
      enabled: true,
      converters: converterNames,
      limits: {
        max_record_bytes: datasetLimits.max_record_bytes,
        max_snapshot_records: datasetLimits.max_records,
        max_canonical_bytes: datasetLimits.max_canonical_bytes,
        max_request_bytes: jsonlLimits.max_request_bytes,
        max_nesting_depth: jsonlLimits.max_nesting_depth,
        max_json_schema_bytes: DEFAULT_TOOL_SCHEMA_LIMITS_V2.maxSchemaBytes,
        max_json_schema_nodes: DEFAULT_TOOL_SCHEMA_LIMITS_V2.maxSchemaNodes,
        max_lineage_depth: V2_LINEAGE_MAX_DEPTH,
        max_lineage_nodes: V2_LINEAGE_MAX_NODES,
        max_transform_inputs: transformLimits.max_input_datasets,
        max_transform_working_set_bytes: transformLimits.max_working_set_bytes,
        max_concurrent_transforms: transformLimits.max_concurrent_runs,
      },
    }),
  )
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined) return await promise
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) onAbort()
  })
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

function snapshotTransformLimits(
  input: Partial<V2TransformLimits> | undefined,
  maxCanonicalBytes: number,
): Readonly<V2TransformLimits> {
  if (input !== undefined && (input === null || typeof input !== 'object')) {
    throw new TypeError('V2 transform limits must be an object')
  }
  const maxInputDatasets = positiveSafeInteger(
    'max_input_datasets',
    input?.max_input_datasets ?? V2_TRANSFORM_MAX_INPUTS,
  )
  if (maxInputDatasets > V2_TRANSFORM_MAX_INPUTS) {
    throw new TypeError(`max_input_datasets must not exceed ${V2_TRANSFORM_MAX_INPUTS}`)
  }
  return Object.freeze({
    max_input_datasets: maxInputDatasets,
    max_working_set_bytes: nonNegativeSafeInteger(
      'max_working_set_bytes',
      input?.max_working_set_bytes ??
        checkedMultiply(maxCanonicalBytes, DEFAULT_V2_TRANSFORM_WORKING_SET_MULTIPLIER),
    ),
    max_concurrent_runs: positiveSafeInteger(
      'max_concurrent_runs',
      input?.max_concurrent_runs ?? DEFAULT_V2_TRANSFORM_CONCURRENCY,
    ),
    max_pending_runs: positiveSafeInteger(
      'max_pending_runs',
      input?.max_pending_runs ?? DEFAULT_V2_TRANSFORM_MAX_PENDING,
    ),
  })
}

interface ExpectedRunV2 {
  readonly cacheKey: string
  readonly runId: string
  readonly op: string
  readonly opVersion: string
  readonly inputVersions: readonly string[]
  readonly params: JsonObjectV2
  readonly outputVersion?: string
}

function validateRunRow(row: CatalogRunRowV2, expected: ExpectedRunV2): RunMetadataV2 {
  let paramsMatch = false
  try {
    paramsMatch = canonicalJsonV2(row.params) === canonicalJsonV2(expected.params)
  } catch {
    paramsMatch = false
  }
  if (
    row.cacheKey !== expected.cacheKey ||
    row.id !== expected.runId ||
    row.op !== expected.op ||
    row.opVersion !== expected.opVersion ||
    row.inputVersions.length !== expected.inputVersions.length ||
    row.inputVersions.some((version, index) => version !== expected.inputVersions[index]) ||
    !paramsMatch ||
    !EXACT_VERSION.test(row.outputVersion) ||
    (expected.outputVersion !== undefined && row.outputVersion !== expected.outputVersion) ||
    typeof row.lineageSequence !== 'bigint' ||
    row.lineageSequence <= 0n ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  ) {
    throw new IntegrityError('Stored V2 transform run metadata is inconsistent', {
      reason: 'transform_run_metadata_mismatch',
      cache_key: expected.cacheKey,
    })
  }
  return runMetadataFromCatalogRow(row, expected.cacheKey)
}

function runMetadataFromCatalogRow(row: CatalogRunRowV2, expectedCacheKey: string): RunMetadataV2 {
  try {
    if (row.cacheKey !== expectedCacheKey) throw new Error('Catalog returned a different cache key')
    return RunMetadataV2Schema.parse({
      run_id: row.id,
      cache_key: row.cacheKey,
      op: row.op,
      op_version: row.opVersion,
      input_dataset_versions: row.inputVersions,
      normalized_params: row.params,
      output_dataset_version: row.outputVersion,
      created_at: row.createdAt.toISOString(),
    })
  } catch (error) {
    throw new IntegrityError('Stored V2 transform run failed strict validation', {
      reason: 'transform_run_invalid',
      cache_key: expectedCacheKey,
      cause: error instanceof Error ? error.name : typeof error,
    })
  }
}

function releaseLeases(leases: readonly V2DatasetLease[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    leases[index]?.release()
  }
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
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
