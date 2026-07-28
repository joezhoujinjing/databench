import { parse as parsePath, resolve as resolvePath } from 'node:path'
import {
  type DeleteRefResultV2 as CatalogDeleteRefResultV2,
  type CatalogEvaluationRunCursorV2,
  type CatalogEvaluationRunListFilterV2,
  type CatalogEvaluationRunPageV2,
  type CatalogEvaluationRunRowV2,
  type CatalogIdentityClaimInputV2,
  type CatalogIdentityClaimResultV2,
  type CatalogLayoutRowV2,
  type CatalogRefPageV2,
  type CatalogRefRowV2,
  type RestoreRefResultV2 as CatalogRestoreRefResultV2,
  type CatalogRunPageV2,
  type CatalogRunRowV2,
  type CatalogSnapshotRowV2,
  type CatalogSwiftStudioSessionCreateResultV2,
  type CatalogSwiftStudioSessionCursorV2,
  type CatalogSwiftStudioSessionFailureV2,
  type CatalogSwiftStudioSessionListFilterV2,
  type CatalogSwiftStudioSessionPageV2,
  type CatalogSwiftStudioSessionRowV2,
  type CatalogTransformJobCursorV2,
  type CatalogTransformJobPageV2,
  type CatalogTransformJobRowV2,
  type ClearCompletedTransformJobStagingV2,
  type CompareAndSetRefV2,
  type CompleteTransformJobV2,
  type CreateEvaluationRunV2,
  type CreateSwiftStudioSessionV2,
  type CreateTransformJobV2,
  type DeleteRefV2,
  type RegisterLayoutV2,
  type RegisterTransformResultV2,
  type RestoreRefV2,
  type TransitionEvaluationRunV2,
  type TransitionSwiftStudioSessionV2,
  V2Catalog,
  V2CatalogDeterminismConflictError,
  V2CatalogRefConflictError,
  V2CatalogSwiftStudioSessionConflictError,
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
  hashV2EvaluationRunCreate,
  hashV2SwiftStudioSessionCreate,
  hashV2TransformCache,
  V2_EVALUATION_RUN_CREATE_PROFILE,
  V2_EXPORT_FIDELITY_PROFILE,
  V2_IDENTITY_PROFILE,
  V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
} from '@databench/hashing'
import {
  createDefaultV2ConverterRegistry,
  DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2,
  readCanonicalDraftJsonlV1,
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
  type CancelEvaluationRunRequestV2,
  CancelEvaluationRunRequestV2Schema,
  type CanonicalDraftRecordV1,
  CapacityExceededError,
  type CompleteEvaluationRunRequestV2,
  CompleteEvaluationRunRequestV2Schema,
  type ConverterAnalysisV2,
  type ConverterDescriptorV2,
  ConverterDescriptorV2Schema,
  type ConverterNameV2,
  ConverterNameV2Schema,
  type CreateBasicCleanJobRequestV2,
  CreateBasicCleanJobRequestV2Schema,
  type CreateEvaluationRunRequestV2,
  CreateEvaluationRunRequestV2Schema,
  type CreateSwiftStudioSessionRequestV2,
  CreateSwiftStudioSessionRequestV2Schema,
  type CursorPageRequestV2,
  CursorPageRequestV2Schema,
  canonicalPreviewRecordFromDraftV1,
  createExportPlanV2,
  createPostTrainingV2Capability,
  createRecordSummaryV2,
  type DatasetLayoutIdentityV2,
  type DatasetLineageV2,
  DatasetLineageV2Schema,
  type DatasetManifestV2,
  type DatasetViewV2,
  DatasetViewV2Schema,
  DEFAULT_RAW_JSON_LIMITS_V2,
  DEFAULT_TOOL_SCHEMA_LIMITS_V2,
  type DeletedRefMetadataV2,
  type DeletedRefPageV2,
  DeletedRefPageV2Schema,
  type DeleteRefRequestV2,
  DeleteRefRequestV2Schema,
  type DeleteRefResultV2,
  DeleteRefResultV2Schema,
  DeterminismConflictErrorV2,
  DigestHexV2Schema,
  datasetLayoutIdentityV2FromManifest,
  deriveRecordEligibilityV2,
  EvaluationRunIdV2Schema,
  type EvaluationRunPageRequestV2,
  EvaluationRunPageRequestV2Schema,
  type EvaluationRunPageV2,
  EvaluationRunPageV2Schema,
  EvaluationRunStateConflictErrorV2,
  type EvaluationRunV2,
  type ExportPlanV2,
  type ExportRequestV2,
  ExportRequestV2Schema,
  type FailEvaluationRunRequestV2,
  FailEvaluationRunRequestV2Schema,
  type IngestResultV2,
  IngestResultV2Schema,
  type InspectExportRequestV2,
  InspectExportRequestV2Schema,
  IntegrityError,
  type JsonObjectV2,
  type LineagePageRequestV2,
  LineagePageRequestV2Schema,
  MCP_MAX_PREVIEW_RECORDS,
  type McpCanonicalDraftValidationPreviewResult,
  McpCanonicalDraftValidationPreviewResultSchema,
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
  type RestoreRefRequestV2,
  RestoreRefRequestV2Schema,
  type RestoreRefResultV2,
  RestoreRefResultV2Schema,
  type RunMetadataV2,
  RunMetadataV2Schema,
  type RunTransformRequestV2,
  RunTransformRequestV2Schema,
  type RunTransformResultV2,
  RunTransformResultV2Schema,
  ServiceUnavailableError,
  StartEvaluationRunRequestV2Schema,
  SwiftStudioSessionIdV2Schema,
  type SwiftStudioSessionPageRequestV2,
  SwiftStudioSessionPageRequestV2Schema,
  type SwiftStudioSessionPageV2,
  SwiftStudioSessionPageV2Schema,
  SwiftStudioSessionStateConflictErrorV2,
  type SwiftStudioSessionV2,
  TransformCacheIdentityV1Schema,
  type TransformDescriptorV2,
  TransformDescriptorV2Schema,
  TransformJobIdV2Schema,
  type TransformJobPageRequestV2,
  TransformJobPageRequestV2Schema,
  type TransformJobPageV2,
  TransformJobPageV2Schema,
  TransformJobStateConflictErrorV2,
  type TransformJobV2,
  V2_LINEAGE_MAX_DEPTH,
  V2_LINEAGE_MAX_NODES,
  V2_RECORD_JSON_LAYOUT_VERSION,
  V2_TRANSFORM_MAX_INPUTS,
  ValidationError,
} from '@databench/schema'
import {
  createV2ObjectStore,
  FileBackedV2Store,
  type PreparedArtifactV2,
  type V2ObjectStoreConfig,
  type V2OperationContext,
  type V2Store,
  V2TempStore,
  v2ObjectStoreConfigFromEnv,
  type WorkerStagingStoreV1,
  workerStagingKeyV1,
} from '@databench/store'
import {
  BASIC_CLEAN_OPERATION_V1,
  compileBasicCleanWorkerParametersV1,
  DATA_JUICER_BATCH_CAPABILITY_V1,
} from '../internal/worker/data-juicer.js'
import type { WorkerFinalizationContext } from '../internal/worker/dispatcher.js'
import {
  registerWorkerCatalog,
  registerWorkerWorkspaceOperations,
  unregisterWorkerCatalog,
  unregisterWorkerWorkspaceOperations,
} from '../internal/worker/workspace-access.js'
import {
  readWorkerRetainedJsonlV1,
  type WorkerRetainedTerminalV1,
  writeWorkerRecordTextJsonlV1,
} from './batch-transform.js'
import {
  V2DatasetCache,
  type V2DatasetCacheKey,
  type V2DatasetLease,
  v2DatasetCacheRequiredWeight,
} from './cache.js'
import {
  materializeCanonicalDraftJsonlV1,
  type V2CanonicalDraftMaterialization,
  type V2CanonicalDraftMaterializeOptions,
} from './canonical-draft-materializer.js'
import { V2CursorCodec } from './cursor.js'
import { evaluationBenchmarkFromPlanV2, evaluationRunFromCatalogV2 } from './evaluation.js'
import { V2WorkspaceIdentityAllocator } from './identity-allocator.js'
import {
  deletedRefMetadataFromCatalog,
  layoutIdentityFromCatalog,
  manifestFromCatalogIdentity,
  mapV2CatalogError,
  refMetadataFromCatalog,
  registrationFromCommittedDataset,
  transformJobFromCatalog,
} from './mappings.js'
import {
  swiftStudioProviderSessionIdForDigestV2,
  swiftStudioSessionFromCatalogV2,
} from './swift-studio.js'
import {
  type ClosedSwiftStudioProviderSessionV2,
  HttpSwiftStudioProvider,
  type HttpSwiftStudioProviderOptions,
  SwiftStudioProviderConflictError,
  type SwiftStudioProviderExpectedExportV2,
  type SwiftStudioProviderSessionV2,
  type SwiftStudioProviderV2,
} from './swift-studio-provider.js'
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
const SWIFT_STUDIO_RECONCILE_TIMEOUT_MS = 10_000
const DEFAULT_SWIFT_STUDIO_ABANDON_GRACE_MS = 310_000

export interface V2WorkspaceCatalog {
  getOrCreateNamespace(scope: 'default'): Promise<string>
  insertOrReadIdentityClaim(
    input: CatalogIdentityClaimInputV2,
  ): Promise<CatalogIdentityClaimResultV2>
  registerCommittedLayout(input: RegisterLayoutV2): Promise<void>
  registerTransformResult(input: RegisterTransformResultV2): Promise<void>
  completeTransformJob(input: CompleteTransformJobV2): Promise<CatalogTransformJobRowV2>
  clearCompletedTransformJobStagingKeys(
    input: ClearCompletedTransformJobStagingV2,
  ): Promise<boolean>
  createOrReadTransformJob(input: CreateTransformJobV2): Promise<CatalogTransformJobRowV2>
  getTransformJob(id: string): Promise<CatalogTransformJobRowV2 | null>
  listTransformJobs(
    before: CatalogTransformJobCursorV2 | null,
    limit: number,
  ): Promise<CatalogTransformJobPageV2>
  requestTransformJobCancellation(id: string): Promise<CatalogTransformJobRowV2 | null>
  retryTransformJob(id: string): Promise<CatalogTransformJobRowV2 | null>
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
  getDeletedRef(namespaceId: string, name: string): Promise<CatalogRefRowV2 | null>
  compareAndSetRef(input: CompareAndSetRefV2): Promise<CatalogRefRowV2>
  deleteRef(input: DeleteRefV2): Promise<CatalogDeleteRefResultV2>
  listRefs(namespaceId: string, afterName: string | null, limit: number): Promise<CatalogRefPageV2>
  listDeletedRefs(
    namespaceId: string,
    afterName: string | null,
    limit: number,
  ): Promise<CatalogRefPageV2>
  restoreRef(input: RestoreRefV2): Promise<CatalogRestoreRefResultV2>
  createOrReadEvaluationRun(input: CreateEvaluationRunV2): Promise<CatalogEvaluationRunRowV2>
  getEvaluationRun(namespaceId: string, id: string): Promise<CatalogEvaluationRunRowV2 | null>
  listEvaluationRuns(
    namespaceId: string,
    filter: CatalogEvaluationRunListFilterV2,
    before: CatalogEvaluationRunCursorV2 | null,
    limit: number,
  ): Promise<CatalogEvaluationRunPageV2>
  transitionEvaluationRun(
    input: TransitionEvaluationRunV2,
  ): Promise<CatalogEvaluationRunRowV2 | null>
}

export interface V2WorkspaceSwiftStudioCatalog {
  createOrReadSwiftStudioSession(
    input: CreateSwiftStudioSessionV2,
  ): Promise<CatalogSwiftStudioSessionCreateResultV2>
  getSwiftStudioSession(
    namespaceId: string,
    id: string,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null>
  abandonSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    preparationOwnerToken: string,
  ): Promise<boolean>
  renewSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    preparationOwnerToken: string,
  ): Promise<boolean>
  claimSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    observedPreparationOwnerToken: string,
    preparationAbandonGraceMs: number,
  ): Promise<{
    readonly row: CatalogSwiftStudioSessionRowV2 | null
    readonly claimed: boolean
  }>
  listSwiftStudioSessions(
    namespaceId: string,
    filter: CatalogSwiftStudioSessionListFilterV2,
    before: CatalogSwiftStudioSessionCursorV2 | null,
    limit: number,
  ): Promise<CatalogSwiftStudioSessionPageV2>
  transitionSwiftStudioSession(
    input: TransitionSwiftStudioSessionV2,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null>
}

export interface V2WorkspaceOperationOptions extends V2OperationContext {}

export interface V2CanonicalJsonlPreviewOptions {
  readonly previewRecords?: number
  readonly maxResponseBytes: number
}

export interface V2CanonicalDraftImportOptions {
  readonly materialize?: V2CanonicalDraftMaterializeOptions
  readonly ingest: AddRecordsV2Options
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
  readonly tempStore?: V2TempStore
  readonly cursorSecret: Uint8Array | string
  readonly cache?: V2DatasetCache
  readonly datasetLimits?: V2DatasetLimits
  readonly transformRegistry?: V2TransformRegistry
  readonly converterRegistry?: V2ConverterRegistry
  readonly transformLimits?: Partial<V2TransformLimits>
  readonly jsonlLimits?: Partial<V2JsonlLimits>
  readonly onCleanupError?: (error: unknown, primaryError: unknown | null) => void
  readonly swiftStudio?: V2SwiftStudioWorkspaceOptions
}

export interface V2SwiftStudioWorkspaceOptions {
  readonly catalog: V2WorkspaceSwiftStudioCatalog
  readonly provider: SwiftStudioProviderV2
  readonly datasetExportBaseUrl: string
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly runtimeCapabilityDigest: string
  readonly preparationAbandonGraceMs?: number
}

type ResolvedV2SwiftStudioWorkspaceOptions = Omit<
  V2SwiftStudioWorkspaceOptions,
  'preparationAbandonGraceMs'
> & {
  readonly preparationAbandonGraceMs: number
}

export interface V2SwiftStudioWorkspaceOpenOptions
  extends Omit<HttpSwiftStudioProviderOptions, 'baseUrl'> {
  readonly providerBaseUrl: string
  readonly datasetExportBaseUrl: string
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly runtimeCapabilityDigest: string
}

export interface V2WorkspaceOpenOptions {
  readonly root?: string
  readonly databaseUrl?: string
  readonly storeConfig?: V2ObjectStoreConfig
  readonly cursorSecret: Uint8Array | string
  readonly datasetLimits?: V2DatasetLimits
  readonly transformLimits?: Partial<V2TransformLimits>
  readonly jsonlLimits?: Partial<V2JsonlLimits>
  readonly swiftStudio?: V2SwiftStudioWorkspaceOpenOptions
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
  readonly #tempStore: V2TempStore
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
  readonly #swiftStudio: Readonly<ResolvedV2SwiftStudioWorkspaceOptions> | null
  #namespacePromise: Promise<string> | undefined
  #closeOwnedResources: (() => Promise<void>) | undefined
  #closePromise: Promise<void> | undefined

  static async open(optionsInput: V2WorkspaceOpenOptions): Promise<V2Workspace> {
    const options = snapshotV2WorkspaceOpenOptions(optionsInput)
    const catalog = new V2Catalog(
      options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
    )
    try {
      const objectStore = createV2ObjectStore(options.storeConfig ?? v2ObjectStoreConfigFromEnv())
      const tempRoot = v2WorkspaceTempRoot(options.root)
      const tempStore = new V2TempStore({ tempRoot })
      const store = new FileBackedV2Store({
        objectStore,
        tempRoot,
        tempStore,
        ...(options.datasetLimits === undefined ? {} : { datasetLimits: options.datasetLimits }),
      })
      const workspace = new V2Workspace({
        catalog,
        store,
        tempStore,
        cursorSecret: options.cursorSecret,
        ...(options.datasetLimits === undefined ? {} : { datasetLimits: options.datasetLimits }),
        ...(options.transformLimits === undefined
          ? {}
          : { transformLimits: options.transformLimits }),
        ...(options.jsonlLimits === undefined ? {} : { jsonlLimits: options.jsonlLimits }),
        ...(options.swiftStudio === undefined
          ? {}
          : {
              swiftStudio: {
                catalog,
                provider: new HttpSwiftStudioProvider({
                  baseUrl: options.swiftStudio.providerBaseUrl,
                  ...(options.swiftStudio.credential === undefined
                    ? {}
                    : { credential: options.swiftStudio.credential }),
                  ...(options.swiftStudio.fetch === undefined
                    ? {}
                    : { fetch: options.swiftStudio.fetch }),
                  ...(options.swiftStudio.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: options.swiftStudio.timeoutMs }),
                }),
                datasetExportBaseUrl: options.swiftStudio.datasetExportBaseUrl,
                upstreamCommit: options.swiftStudio.upstreamCommit,
                imageDigest: options.swiftStudio.imageDigest,
                runtimeCapabilityDigest: options.swiftStudio.runtimeCapabilityDigest,
                preparationAbandonGraceMs:
                  (options.swiftStudio.timeoutMs ?? 300_000) + SWIFT_STUDIO_RECONCILE_TIMEOUT_MS,
              },
            }),
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
    if (options.tempStore !== undefined && !(options.tempStore instanceof V2TempStore)) {
      throw new TypeError('V2Workspace tempStore must be a V2TempStore')
    }
    this.#catalog = options.catalog
    this.#store = options.store
    this.#tempStore = options.tempStore ?? new V2TempStore({ tempRoot: v2WorkspaceTempRoot() })
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
    this.#swiftStudio =
      options.swiftStudio === undefined
        ? null
        : snapshotSwiftStudioWorkspaceOptions(options.swiftStudio)
    this.#runtimeCapability = postTrainingV2Capability({
      datasetLimits: this.#datasetLimits,
      jsonlLimits: this.#jsonlLimits,
      transformLimits: this.#transformLimits,
      converterRegistry: this.#converterRegistry,
    })
    registerWorkerCatalog(this, options.catalog)
    registerWorkerWorkspaceOperations(this, {
      projectInput: (job, signal) => this.#projectWorkerInput(job, signal),
      finalize: async (context, staging) => {
        await this.#finalizeWorkerJob(context, staging)
      },
    })
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      unregisterWorkerWorkspaceOperations(this)
      unregisterWorkerCatalog(this)
      await (this.#closeOwnedResources?.() ?? Promise.resolve())
    })()
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

  async previewCanonicalDraftJsonl(
    source: AsyncIterable<Uint8Array>,
    optionsInput: V2CanonicalJsonlPreviewOptions,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<Readonly<McpCanonicalDraftValidationPreviewResult>> {
    context.signal?.throwIfAborted()
    const options = snapshotCanonicalPreviewOptions(optionsInput)
    const hasher = createArtifactHasher()
    const previewDrafts: CanonicalDraftRecordV1[] = []
    let recordCount = 0
    const operationOptions = operationContext(context.signal)
    const parsed = readCanonicalDraftJsonlV1(hashCanonicalSource(source, hasher, context.signal), {
      limits: {
        maxBytes: this.#datasetLimits.max_record_bytes,
        maxDepth: this.#jsonlLimits.max_nesting_depth,
      },
      maxTransportBytes: this.#jsonlLimits.max_request_bytes,
      ...operationOptions,
    })
    const canonicalRecords = canonicalPreviewRecordsFromDrafts(
      parsed,
      previewDrafts,
      options.previewRecords,
      () => {
        recordCount += 1
      },
    )

    await V2Dataset.fromAsyncRecords(canonicalRecords, this.#datasetLimits, operationOptions)
    context.signal?.throwIfAborted()
    return fitPreviewResult(
      {
        format: 'canonical-draft-jsonl-v1',
        input_digest: hasher.digestHex(),
        record_count: recordCount,
        records: previewDrafts,
        records_truncated: false,
      },
      options.previewRecords,
      options.maxResponseBytes,
      (value) => McpCanonicalDraftValidationPreviewResultSchema.parse(value),
    )
  }

  async materializeCanonicalDraftJsonl(
    source: AsyncIterable<Uint8Array>,
    options: V2CanonicalDraftMaterializeOptions = {},
    context: V2WorkspaceOperationOptions = {},
  ): Promise<Readonly<V2CanonicalDraftMaterialization>> {
    context.signal?.throwIfAborted()
    const signal = context.signal ?? new AbortController().signal
    return await materializeCanonicalDraftJsonlV1({
      source,
      options,
      tempStore: this.#tempStore,
      catalog: this.#catalog,
      getNamespace: async () => await this.#namespace(signal),
      datasetLimits: this.#datasetLimits,
      jsonlLimits: this.#jsonlLimits,
      signal,
    })
  }

  async addCanonicalDraftJsonl(
    source: AsyncIterable<Uint8Array>,
    options: V2CanonicalDraftImportOptions,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<IngestResultV2> {
    const materialized = await this.materializeCanonicalDraftJsonl(
      source,
      options.materialize ?? {},
      context,
    )
    let result: IngestResultV2
    try {
      result = await this.addJsonl(materialized.bytes, options.ingest, context)
    } catch (error) {
      try {
        await materialized.dispose()
      } catch (cleanupError) {
        attachSuppressed(error, cleanupError)
      }
      throw error
    }
    await materialized.dispose()
    return result
  }

  listTransforms(): readonly Readonly<TransformDescriptorV2>[] {
    return Object.freeze(
      this.#transformRegistry
        .descriptors()
        .map((descriptor) => Object.freeze(TransformDescriptorV2Schema.parse(descriptor))),
    )
  }

  async createBasicCleanJob(
    requestInput: CreateBasicCleanJobRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<TransformJobV2> {
    context.signal?.throwIfAborted()
    const request = CreateBasicCleanJobRequestV2Schema.parse(requestInput)
    const resolved = await this.#resolveLayout(request.inputs[0], context.signal)
    const lease = await this.#acquire(resolved.identity, context.signal)
    let inputCount: number
    try {
      context.signal?.throwIfAborted()
      if (lease.dataset.version !== resolved.identity.dataset_version) {
        throw new IntegrityError('Basic-clean input resolved to a different Dataset', {
          reason: 'transform_job_input_mismatch',
          expected_dataset_version: resolved.identity.dataset_version,
          actual_dataset_version: lease.dataset.version,
        })
      }
      inputCount = lease.dataset.length
    } finally {
      lease.release()
    }

    const params = Object.freeze({})
    const cacheIdentity = TransformCacheIdentityV1Schema.parse({
      identity_profile: V2_IDENTITY_PROFILE,
      op: BASIC_CLEAN_OPERATION_V1,
      op_version: '1',
      input_dataset_versions: [resolved.identity.dataset_version],
      params,
    })
    const cacheKey = hashV2TransformCache(cacheIdentity)
    const resultRefNamespaceId =
      request.result_ref === undefined ? null : await this.#namespace(context.signal)
    let row: CatalogTransformJobRowV2
    try {
      row = await waitWithAbort(
        this.#catalog.createOrReadTransformJob({
          id: `job_${cacheKey}`,
          cacheKey,
          op: BASIC_CLEAN_OPERATION_V1,
          opVersion: '1',
          params,
          inputVersion: resolved.identity.dataset_version,
          capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
          capabilityVersion: '1',
          inputCount: BigInt(inputCount),
          resultRefNamespaceId,
          resultRefName: request.result_ref ?? null,
        }),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      if (error instanceof V2CatalogDeterminismConflictError) {
        throw new IntegrityError(
          'This input already has a basic-clean job bound to a different result name',
          {
            reason: 'transform_job_identity_conflict',
            cache_key: cacheKey,
          },
        )
      }
      mapV2CatalogError(error, false)
    }
    if (row.status === 'completed' && row.outputVersion !== null) {
      await this.#verifyTransformOutput(
        row.outputVersion,
        context.signal ?? new AbortController().signal,
      )
    }
    return transformJobFromCatalog(row)
  }

  async listTransformJobs(
    requestInput: TransformJobPageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<TransformJobPageV2> {
    context.signal?.throwIfAborted()
    const request = TransformJobPageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const before =
      request.cursor === null
        ? null
        : transformJobCatalogCursor(this.#cursor.decodeTransformJob(request.cursor, namespaceId))
    let page: CatalogTransformJobPageV2
    try {
      page = await waitWithAbort(
        this.#catalog.listTransformJobs(before, request.limit),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (page.rows.length > request.limit) {
      throw new IntegrityError('Catalog returned too many transform jobs', {
        reason: 'transform_job_page_overflow',
      })
    }
    return TransformJobPageV2Schema.parse({
      items: page.rows.map(transformJobFromCatalog),
      next_cursor:
        page.nextCursor === null
          ? null
          : this.#cursor.encodeTransformJob(namespaceId, {
              created_at: page.nextCursor.createdAt.toISOString(),
              id: page.nextCursor.id,
            }),
    })
  }

  async getTransformJob(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<TransformJobV2 | null> {
    context.signal?.throwIfAborted()
    const id = TransformJobIdV2Schema.parse(idInput)
    let row: CatalogTransformJobRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.getTransformJob(id), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    return row === null ? null : transformJobFromCatalog(row)
  }

  async cancelTransformJob(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<TransformJobV2> {
    context.signal?.throwIfAborted()
    const id = TransformJobIdV2Schema.parse(idInput)
    let row: CatalogTransformJobRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.requestTransformJobCancellation(id), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row === null) {
      throw new NotFoundError(`Transform job was not found: ${id}`, { job_id: id })
    }
    return transformJobFromCatalog(row)
  }

  async retryTransformJob(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<TransformJobV2> {
    context.signal?.throwIfAborted()
    const id = TransformJobIdV2Schema.parse(idInput)
    const existing = await this.getTransformJob(id, context)
    if (existing === null) {
      throw new NotFoundError(`Transform job was not found: ${id}`, { job_id: id })
    }
    if (existing.status !== 'failed' && existing.status !== 'cancelled') {
      throw new TransformJobStateConflictErrorV2({
        reason: 'not_retryable',
        job_id: id,
        status: existing.status,
      })
    }
    let row: CatalogTransformJobRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.retryTransformJob(id), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row === null) {
      const current = await this.getTransformJob(id, context)
      if (current?.status === 'queued') return current
      throw new TransformJobStateConflictErrorV2({
        reason: 'cleanup_pending',
        job_id: id,
        status: current?.status ?? existing.status,
      })
    }
    return transformJobFromCatalog(row)
  }

  async createEvaluationRun(
    requestInput: CreateEvaluationRunRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2> {
    context.signal?.throwIfAborted()
    const request = CreateEvaluationRunRequestV2Schema.parse(requestInput)
    const descriptor = this.getConverter(request.converter)
    if (descriptor === null || !descriptor.task_views.includes('evaluation-qa')) {
      throw new ValidationError('Converter does not support EvalScope evaluation tasks', {
        issues: [
          {
            path: '/converter',
            line: null,
            code: 'evaluation_converter_required',
            message: 'Converter must support the evaluation-qa task view',
          },
        ],
      })
    }
    const plan = await this.inspectExport(
      request.dataset_version,
      { converter: request.converter, options: request.converter_options },
      context,
    )
    assertExportFidelityAcceptedV2(plan, request.accepted_fidelity_digest)
    const benchmark = evaluationBenchmarkFromPlanV2(plan)
    const namespaceId = await this.#namespace(context.signal)
    const createRequestDigest = hashV2EvaluationRunCreate({
      evaluation_run_create_profile: V2_EVALUATION_RUN_CREATE_PROFILE,
      provider: request.provider,
      provider_task_id: request.provider_task_id,
      dataset_version: request.dataset_version,
      source_ref: request.source_ref,
      converter: request.converter,
      converter_version: plan.converter_version,
      normalized_options: plan.normalized_options,
      fidelity_digest: plan.fidelity_digest,
      benchmark,
      model_name: request.model_name,
      evalscope_commit: request.evalscope_commit,
    })
    let row: CatalogEvaluationRunRowV2
    try {
      row = await waitWithAbort(
        this.#catalog.createOrReadEvaluationRun({
          namespaceId,
          provider: request.provider,
          providerTaskId: request.provider_task_id,
          createRequestDigest,
          datasetVersion: request.dataset_version,
          sourceRef: request.source_ref,
          converter: request.converter,
          converterVersion: plan.converter_version,
          converterOptions: plan.normalized_options,
          fidelityDigest: plan.fidelity_digest,
          benchmark,
          modelName: request.model_name,
          evalscopeCommit: request.evalscope_commit,
        }),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row.namespaceId !== namespaceId) {
      throw new IntegrityError('Catalog returned an evaluation run from another namespace', {
        reason: 'evaluation_namespace_mismatch',
        dataset_version: request.dataset_version,
      })
    }
    if (row.createRequestDigest !== createRequestDigest) {
      throw new EvaluationRunStateConflictErrorV2({
        reason: 'create_request_mismatch',
        run_id: row.id,
        status: row.status,
        requested_status: null,
      })
    }
    return evaluationRunFromCatalogV2(row)
  }

  async getEvaluationRun(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2 | null> {
    context.signal?.throwIfAborted()
    const id = EvaluationRunIdV2Schema.parse(idInput)
    const namespaceId = await this.#namespace(context.signal)
    let row: CatalogEvaluationRunRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.getEvaluationRun(namespaceId, id), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    return row === null ? null : evaluationRunFromCatalogV2(row)
  }

  async listEvaluationRuns(
    requestInput: EvaluationRunPageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunPageV2> {
    context.signal?.throwIfAborted()
    const request = EvaluationRunPageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const datasetVersion = request.dataset_version ?? null
    const status = request.status ?? null
    const cursorState =
      request.cursor === null
        ? null
        : this.#cursor.decodeEvaluationRun(request.cursor, namespaceId, datasetVersion, status)
    const before =
      cursorState === null
        ? null
        : { createdAt: new Date(cursorState.created_at), id: cursorState.id }
    let page: CatalogEvaluationRunPageV2
    try {
      page = await waitWithAbort(
        this.#catalog.listEvaluationRuns(
          namespaceId,
          { datasetVersion, status },
          before,
          request.limit,
        ),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (page.rows.length > request.limit) {
      throw new IntegrityError('Catalog returned too many evaluation runs', {
        reason: 'evaluation_run_page_overflow',
      })
    }
    return EvaluationRunPageV2Schema.parse({
      items: page.rows.map(evaluationRunFromCatalogV2),
      next_cursor:
        page.nextCursor === null
          ? null
          : this.#cursor.encodeEvaluationRun(namespaceId, {
              created_at: page.nextCursor.createdAt.toISOString(),
              id: page.nextCursor.id,
              dataset_version: datasetVersion,
              status,
            }),
    })
  }

  async startEvaluationRun(
    idInput: string,
    requestInput: unknown,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2> {
    context.signal?.throwIfAborted()
    StartEvaluationRunRequestV2Schema.parse(requestInput)
    return await this.#transitionEvaluationRun(
      {
        namespaceId: await this.#namespace(context.signal),
        id: EvaluationRunIdV2Schema.parse(idInput),
        status: 'running',
      },
      context,
    )
  }

  async completeEvaluationRun(
    idInput: string,
    requestInput: CompleteEvaluationRunRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2> {
    context.signal?.throwIfAborted()
    const id = EvaluationRunIdV2Schema.parse(idInput)
    const request = CompleteEvaluationRunRequestV2Schema.parse(requestInput)
    return await this.#transitionEvaluationRun(
      {
        namespaceId: await this.#namespace(context.signal),
        id,
        status: 'completed',
        metrics: request.metrics.map((metric) => ({
          dataset: metric.dataset,
          subset: metric.subset,
          metric: metric.metric,
          score: metric.score,
          sampleCount: metric.sample_count,
          categories: metric.categories,
        })),
        providerReportIds: request.provider_report_ids,
      },
      context,
    )
  }

  async failEvaluationRun(
    idInput: string,
    requestInput: FailEvaluationRunRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2> {
    context.signal?.throwIfAborted()
    const id = EvaluationRunIdV2Schema.parse(idInput)
    const request = FailEvaluationRunRequestV2Schema.parse(requestInput)
    return await this.#transitionEvaluationRun(
      {
        namespaceId: await this.#namespace(context.signal),
        id,
        status: 'failed',
        error: request.error,
      },
      context,
    )
  }

  async cancelEvaluationRun(
    idInput: string,
    requestInput: CancelEvaluationRunRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<EvaluationRunV2> {
    context.signal?.throwIfAborted()
    const id = EvaluationRunIdV2Schema.parse(idInput)
    const request = CancelEvaluationRunRequestV2Schema.parse(requestInput)
    return await this.#transitionEvaluationRun(
      {
        namespaceId: await this.#namespace(context.signal),
        id,
        status: 'cancelled',
        error: request.error,
      },
      context,
    )
  }

  async #transitionEvaluationRun(
    input: TransitionEvaluationRunV2,
    context: V2WorkspaceOperationOptions,
  ): Promise<EvaluationRunV2> {
    let row: CatalogEvaluationRunRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.transitionEvaluationRun(input), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row === null) {
      throw new NotFoundError(`Evaluation run was not found: ${input.id}`, { run_id: input.id })
    }
    if (row.namespaceId !== input.namespaceId) {
      throw new IntegrityError('Catalog returned an evaluation run from another namespace', {
        reason: 'evaluation_namespace_mismatch',
        dataset_version: row.datasetVersion,
      })
    }
    const run = evaluationRunFromCatalogV2(row)
    if (run.status !== input.status) {
      throw new EvaluationRunStateConflictErrorV2({
        reason: 'invalid_transition',
        run_id: run.id,
        status: run.status,
        requested_status: input.status,
      })
    }
    if (!evaluationTransitionBodyMatches(run, input)) {
      throw new EvaluationRunStateConflictErrorV2({
        reason: 'terminal_body_mismatch',
        run_id: run.id,
        status: run.status,
        requested_status: input.status,
      })
    }
    return run
  }

  async createSwiftStudioSession(
    requestInput: CreateSwiftStudioSessionRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<SwiftStudioSessionV2> {
    context.signal?.throwIfAborted()
    const runtime = this.#requireSwiftStudio()
    const request = CreateSwiftStudioSessionRequestV2Schema.parse(requestInput)
    if (request.display_ref !== null) {
      const displayRef = await this.getRef(request.display_ref, context)
      if (displayRef === null) {
        throw new NotFoundError('Swift Studio display Ref was not found', {
          ref_name: request.display_ref,
        })
      }
      if (displayRef.version !== request.dataset_version) {
        throw new ValidationError('Swift Studio display Ref does not identify the exact Dataset', {
          issues: [
            {
              path: '/display_ref',
              line: null,
              code: 'display_ref_version_mismatch',
              message: 'display_ref must currently resolve to dataset_version',
            },
          ],
        })
      }
    }
    const plan = await this.inspectExport(
      request.dataset_version,
      { converter: request.converter, options: request.options },
      context,
    )
    assertExportFidelityAcceptedV2(plan, request.accepted_fidelity_digest)
    if (plan.converter !== 'ms-swift' || plan.converter_version !== '1.0.0') {
      throw new IntegrityError('Swift Studio converter registration has drifted', {
        reason: 'swift_studio_converter_drift',
      })
    }
    if (plan.output_count === 0) {
      throw new ValidationError('Swift Studio Dataset export is empty', {
        issues: [
          {
            path: '/dataset_version',
            line: null,
            code: 'swift_studio_empty_export',
            message: 'The exact Dataset has no ms-swift training rows',
          },
        ],
      })
    }
    const expected = await this.#measureSwiftStudioExport(
      request.dataset_version,
      plan.output_count,
      plan.fidelity_digest,
      context,
    )
    const namespaceId = await this.#namespace(context.signal)
    const createDigest = hashV2SwiftStudioSessionCreate({
      swift_studio_session_create_profile: V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
      namespace: namespaceId,
      dataset_version: request.dataset_version,
      converter: 'ms-swift',
      converter_version: '1.0.0',
      normalized_options: plan.normalized_options,
      fidelity_digest: plan.fidelity_digest,
      output_count: plan.output_count,
      provider: 'swift-studio',
      upstream_commit: runtime.upstreamCommit,
      image_digest: runtime.imageDigest,
      runtime_capability_digest: runtime.runtimeCapabilityDigest,
    })
    const providerSessionId = swiftStudioProviderSessionIdForDigestV2(createDigest)
    let admission: CatalogSwiftStudioSessionCreateResultV2 | undefined
    for (let attempt = 0; attempt < 2 && admission === undefined; attempt += 1) {
      try {
        admission = await runtime.catalog.createOrReadSwiftStudioSession({
          namespaceId,
          createDigest,
          datasetVersion: request.dataset_version,
          displayRef: request.display_ref,
          converter: 'ms-swift',
          converterVersion: '1.0.0',
          normalizedOptions: plan.normalized_options,
          fidelityDigest: plan.fidelity_digest,
          exportOutputCount: BigInt(plan.output_count),
          provider: 'swift-studio',
          providerSessionId,
          upstreamCommit: runtime.upstreamCommit,
          imageDigest: runtime.imageDigest,
          runtimeCapabilityDigest: runtime.runtimeCapabilityDigest,
        })
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof V2CatalogSwiftStudioSessionConflictError &&
          error.reason === 'active_session_exists' &&
          error.status === 'preparing'
        ) {
          const active = await runtime.catalog.getSwiftStudioSession(namespaceId, error.sessionId)
          if (active !== null) {
            this.#assertSwiftStudioNamespace(active, namespaceId)
            const reconciled = await this.#reconcilePreparingSwiftStudioSession(active)
            if (reconciled.status !== 'preparing') continue
          }
        }
        throw mapSwiftStudioCatalogError(error)
      }
    }
    if (admission === undefined) {
      throw new IntegrityError('Swift Studio Session admission did not return a result', {
        reason: 'swift_studio_session_admission_missing',
      })
    }
    let { row } = admission
    this.#assertSwiftStudioNamespace(row, namespaceId)
    if (row.createDigest !== createDigest) {
      throw new SwiftStudioSessionStateConflictErrorV2({
        reason: 'create_request_mismatch',
        session_id: row.id,
        status: row.status,
        requested_status: null,
      })
    }
    if (row.status === 'preparing' && !admission.created) {
      row = await this.#reconcilePreparingSwiftStudioSession(row)
    }
    if (row.status !== 'preparing' || !admission.created) {
      return swiftStudioSessionFromCatalogV2(row)
    }

    try {
      context.signal?.throwIfAborted()
    } catch (error) {
      await this.#failSwiftStudioSession(row, error, {
        phase: 'provider',
        code: 'prepare_aborted',
        message: 'Studio Session preparation was cancelled before Provider admission',
      })
      throw error
    }

    const renewed = await runtime.catalog.renewSwiftStudioSessionPreparation(
      row.namespaceId,
      row.id,
      row.preparationOwnerToken,
    )
    if (!renewed) {
      const existing = await runtime.catalog.getSwiftStudioSession(row.namespaceId, row.id)
      if (existing === null) {
        throw new IntegrityError('Swift Studio Session disappeared during preparation', {
          reason: 'swift_studio_session_disappeared',
          session_id: row.id,
        })
      }
      this.#assertSwiftStudioNamespace(existing, namespaceId)
      return swiftStudioSessionFromCatalogV2(existing)
    }
    try {
      context.signal?.throwIfAborted()
    } catch (error) {
      await this.#failSwiftStudioSession(row, error, {
        phase: 'provider',
        code: 'prepare_aborted',
        message: 'Studio Session preparation was cancelled before Provider admission',
      })
      throw error
    }

    let prepared: Readonly<SwiftStudioProviderSessionV2>
    try {
      prepared = await runtime.provider.createSession(
        {
          requestId: createDigest,
          datasetVersion: request.dataset_version,
          displayLabel: request.display_ref ?? request.dataset_version,
          exportUrl: swiftStudioExportUrl(runtime.datasetExportBaseUrl, request.dataset_version),
          acceptedFidelityDigest: request.accepted_fidelity_digest,
          expected,
        },
        operationContext(context.signal),
      )
    } catch (error) {
      const current = await this.#reconcileSwiftStudioProviderSession(runtime.provider, error)
      if (current?.providerSessionId === providerSessionId) {
        prepared = current
      } else {
        await this.#abandonSwiftStudioSessionPreparation(row, error)
        const providerHasAnotherSession =
          error instanceof SwiftStudioProviderConflictError ||
          (current !== null && current !== undefined)
        if (providerHasAnotherSession) {
          throw new SwiftStudioSessionStateConflictErrorV2({
            reason: 'active_session_exists',
            session_id: row.id,
            status: row.status,
            requested_status: null,
          })
        }
        throw error
      }
    }
    if (
      prepared.providerSessionId !== providerSessionId ||
      prepared.datasetVersion !== request.dataset_version ||
      prepared.converter !== 'ms-swift' ||
      prepared.converterVersion !== '1.0.0' ||
      prepared.exportDigest !== expected.digest ||
      prepared.exportSizeBytes !== expected.sizeBytes ||
      prepared.outputCount !== expected.lineCount
    ) {
      const integrityError = new IntegrityError('Swift Studio Provider prepared another export', {
        reason: 'swift_studio_provider_export_mismatch',
        session_id: row.id,
      })
      if (prepared.providerSessionId === providerSessionId) {
        const closed = await this.#closeSwiftStudioProviderAfterPreparationFailure(
          runtime.provider,
          providerSessionId,
          createDigest,
          integrityError,
        )
        if (!closed) {
          await this.#abandonSwiftStudioSessionPreparation(row, integrityError)
          throw integrityError
        }
      } else {
        await this.#abandonSwiftStudioSessionPreparation(row, integrityError)
        throw integrityError
      }
      await this.#failSwiftStudioSession(row, integrityError, {
        phase: 'provider',
        code: 'export_mismatch',
        message: 'Provider export verification failed',
      })
      throw integrityError
    }
    const ready = await this.#transitionSwiftStudioSessionReady(
      row,
      expected.digest,
      expected.sizeBytes,
    )
    return swiftStudioSessionFromCatalogV2(ready)
  }

  async getSwiftStudioSession(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<SwiftStudioSessionV2 | null> {
    context.signal?.throwIfAborted()
    const runtime = this.#requireSwiftStudio()
    const id = SwiftStudioSessionIdV2Schema.parse(idInput)
    const namespaceId = await this.#namespace(context.signal)
    let row: CatalogSwiftStudioSessionRowV2 | null
    try {
      row = await waitWithAbort(
        runtime.catalog.getSwiftStudioSession(namespaceId, id),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      throw mapSwiftStudioCatalogError(error)
    }
    if (row === null) return null
    this.#assertSwiftStudioNamespace(row, namespaceId)
    if (row.status === 'preparing') {
      row = await this.#reconcilePreparingSwiftStudioSession(row)
    }
    return swiftStudioSessionFromCatalogV2(row)
  }

  async listSwiftStudioSessions(
    requestInput: SwiftStudioSessionPageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<SwiftStudioSessionPageV2> {
    context.signal?.throwIfAborted()
    const runtime = this.#requireSwiftStudio()
    const request = SwiftStudioSessionPageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const datasetVersion = request.dataset_version ?? null
    const status = request.status ?? null
    const cursorState =
      request.cursor === null
        ? null
        : this.#cursor.decodeSwiftStudioSession(request.cursor, namespaceId, datasetVersion, status)
    const before =
      cursorState === null
        ? null
        : { createdAt: new Date(cursorState.created_at), id: cursorState.id }
    let page: CatalogSwiftStudioSessionPageV2
    try {
      page = await waitWithAbort(
        runtime.catalog.listSwiftStudioSessions(
          namespaceId,
          { datasetVersion, status },
          before,
          request.limit,
        ),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      throw mapSwiftStudioCatalogError(error)
    }
    if (page.rows.length > request.limit) {
      throw new IntegrityError('Catalog returned too many Swift Studio Sessions', {
        reason: 'swift_studio_session_page_overflow',
      })
    }
    for (const row of page.rows) this.#assertSwiftStudioNamespace(row, namespaceId)
    const rows =
      status === null
        ? await Promise.all(
            page.rows.map((row) =>
              row.status === 'preparing'
                ? this.#reconcilePreparingSwiftStudioSession(row)
                : Promise.resolve(row),
            ),
          )
        : page.rows
    return SwiftStudioSessionPageV2Schema.parse({
      items: rows.map(swiftStudioSessionFromCatalogV2),
      next_cursor:
        page.nextCursor === null
          ? null
          : this.#cursor.encodeSwiftStudioSession(namespaceId, {
              created_at: page.nextCursor.createdAt.toISOString(),
              id: page.nextCursor.id,
              dataset_version: datasetVersion,
              status,
            }),
    })
  }

  async closeSwiftStudioSession(
    idInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<SwiftStudioSessionV2> {
    context.signal?.throwIfAborted()
    const runtime = this.#requireSwiftStudio()
    const id = SwiftStudioSessionIdV2Schema.parse(idInput)
    const namespaceId = await this.#namespace(context.signal)
    const row = await this.getSwiftStudioSession(id, context)
    if (row === null) {
      throw new NotFoundError(`Swift Studio Session was not found: ${id}`, { session_id: id })
    }
    if (row.status === 'closed') return row
    if (row.status !== 'ready' && row.status !== 'closing') {
      throw new SwiftStudioSessionStateConflictErrorV2({
        reason: 'invalid_transition',
        session_id: row.id,
        status: row.status,
        requested_status: 'closing',
      })
    }
    const providerSessionId = swiftStudioProviderSessionIdForDigestV2(row.create_digest)
    let closedProvider: Readonly<ClosedSwiftStudioProviderSessionV2>
    try {
      closedProvider = await runtime.provider.closeSession(
        providerSessionId,
        row.create_digest,
        operationContext(context.signal),
      )
    } catch (error) {
      if (
        error instanceof SwiftStudioProviderConflictError &&
        error.providerCode === 'session_has_active_tasks'
      ) {
        throw new SwiftStudioSessionStateConflictErrorV2({
          reason: 'provider_session_busy',
          session_id: row.id,
          status: row.status,
          requested_status: 'closing',
        })
      }
      if (error instanceof SwiftStudioProviderConflictError) {
        throw new ServiceUnavailableError(
          'Swift Studio Provider close state conflicted',
          {
            dependency: 'swift_studio_provider',
            provider_code: error.providerCode,
          },
          { cause: error },
        )
      }
      throw error
    }
    if (closedProvider.providerSessionId !== providerSessionId) {
      throw new IntegrityError('Swift Studio Provider closed another Session', {
        reason: 'swift_studio_provider_close_mismatch',
        session_id: row.id,
      })
    }
    const closed = await this.#convergeClosedSwiftStudioSession(namespaceId, id)
    return swiftStudioSessionFromCatalogV2(closed)
  }

  async #measureSwiftStudioExport(
    datasetVersion: string,
    expectedOutputCount: number,
    acceptedFidelityDigest: string,
    context: V2WorkspaceOperationOptions,
  ): Promise<{
    readonly digestAlgorithm: 'blake3'
    readonly digest: string
    readonly sizeBytes: number
    readonly lineCount: number
  }> {
    const exported = await this.export(
      datasetVersion,
      {
        converter: 'ms-swift',
        options: {},
        accepted_fidelity_digest: acceptedFidelityDigest,
      },
      context,
    )
    const hasher = createArtifactHasher()
    let sizeBytes = 0
    let lineCount = 0
    let lastByte: number | undefined
    for await (const chunk of exported.bytes) {
      context.signal?.throwIfAborted()
      hasher.update(chunk)
      sizeBytes = checkedAddSafeInteger(sizeBytes, chunk.byteLength, 'Swift export byte size')
      for (const byte of chunk) if (byte === 0x0a) lineCount += 1
      if (chunk.byteLength > 0) lastByte = chunk[chunk.byteLength - 1]
    }
    if (sizeBytes > 0 && lastByte !== 0x0a) lineCount += 1
    if (sizeBytes === 0 || lineCount !== expectedOutputCount) {
      throw new IntegrityError('Swift Studio export does not match its inspected output count', {
        reason: 'swift_studio_export_count_mismatch',
        expected_output_count: expectedOutputCount,
        actual_output_count: lineCount,
      })
    }
    return Object.freeze({
      digestAlgorithm: 'blake3',
      digest: hasher.digestHex(),
      sizeBytes,
      lineCount,
    })
  }

  async #failSwiftStudioSession(
    row: CatalogSwiftStudioSessionRowV2,
    primaryError: unknown,
    failure: CatalogSwiftStudioSessionFailureV2,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null> {
    const runtime = this.#requireSwiftStudio()
    let current: CatalogSwiftStudioSessionRowV2 | null = row
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await runtime.catalog.transitionSwiftStudioSession({
          namespaceId: row.namespaceId,
          id: row.id,
          status: 'failed',
          preparationOwnerToken: row.preparationOwnerToken,
          failure,
        })
      } catch (cleanupError) {
        attachSuppressed(primaryError, cleanupError)
        try {
          current = await runtime.catalog.getSwiftStudioSession(row.namespaceId, row.id)
        } catch (readError) {
          attachSuppressed(primaryError, readError)
          break
        }
        if (current === null) return null
        this.#assertSwiftStudioNamespace(current, row.namespaceId)
        if (
          current.status === 'failed' &&
          current.failure?.phase === failure.phase &&
          current.failure.code === failure.code &&
          current.failure.message === failure.message
        ) {
          return current
        }
        if (
          current.status !== 'preparing' ||
          current.preparationOwnerToken !== row.preparationOwnerToken
        ) {
          return current
        }
      }
    }
    if (
      current?.status === 'preparing' &&
      current.preparationOwnerToken === row.preparationOwnerToken
    ) {
      return await this.#abandonSwiftStudioSessionPreparation(current, primaryError)
    }
    return current
  }

  async #reconcileSwiftStudioProviderSession(
    provider: SwiftStudioProviderV2,
    primaryError: unknown,
  ): Promise<Readonly<SwiftStudioProviderSessionV2> | null | undefined> {
    try {
      return await provider.getCurrentSession({
        signal: AbortSignal.timeout(SWIFT_STUDIO_RECONCILE_TIMEOUT_MS),
      })
    } catch (reconcileError) {
      attachSuppressed(primaryError, reconcileError)
      return undefined
    }
  }

  async #closeSwiftStudioProviderAfterPreparationFailure(
    provider: SwiftStudioProviderV2,
    providerSessionId: string,
    requestId: string,
    primaryError: unknown,
  ): Promise<boolean> {
    try {
      const closed = await provider.closeSession(providerSessionId, requestId, {
        signal: AbortSignal.timeout(SWIFT_STUDIO_RECONCILE_TIMEOUT_MS),
      })
      if (closed.providerSessionId !== providerSessionId) {
        throw new IntegrityError('Swift Studio Provider closed another Session', {
          reason: 'swift_studio_provider_close_mismatch',
        })
      }
      return true
    } catch (cleanupError) {
      attachSuppressed(primaryError, cleanupError)
      return false
    }
  }

  async #reconcilePreparingSwiftStudioSession(
    observed: CatalogSwiftStudioSessionRowV2,
  ): Promise<CatalogSwiftStudioSessionRowV2> {
    const runtime = this.#requireSwiftStudio()
    const failureCode =
      observed.preparationAbandonedAt === null ? 'prepare_expired' : 'prepare_unconfirmed'
    let claimed: Awaited<
      ReturnType<V2WorkspaceSwiftStudioCatalog['claimSwiftStudioSessionPreparation']>
    >
    try {
      claimed = await runtime.catalog.claimSwiftStudioSessionPreparation(
        observed.namespaceId,
        observed.id,
        observed.preparationOwnerToken,
        runtime.preparationAbandonGraceMs,
      )
    } catch {
      return observed
    }
    if (claimed.row === null) return observed
    this.#assertSwiftStudioNamespace(claimed.row, observed.namespaceId)
    if (!claimed.claimed) return claimed.row
    let row = claimed.row

    let current: Readonly<SwiftStudioProviderSessionV2> | null
    try {
      current = await runtime.provider.getCurrentSession({
        signal: AbortSignal.timeout(SWIFT_STUDIO_RECONCILE_TIMEOUT_MS),
      })
    } catch (error) {
      row = (await this.#abandonSwiftStudioSessionPreparation(row, error)) ?? row
      return row
    }
    if (current === null) {
      const reconciliationError = new IntegrityError(
        'Swift Studio Session preparation ended without a Provider Session',
        { reason: 'swift_studio_provider_prepare_absent', session_id: row.id },
      )
      return (
        (await this.#failSwiftStudioSession(row, reconciliationError, {
          phase: 'provider',
          code: failureCode,
          message: 'Provider did not retain the Studio Session preparation',
        })) ?? row
      )
    }

    const expectedProviderSessionId = swiftStudioProviderSessionIdForDigestV2(row.createDigest)
    const reconciliationError = new IntegrityError(
      'Swift Studio Session preparation requires Provider reconciliation',
      { reason: 'swift_studio_provider_reconcile', session_id: row.id },
    )
    if (current.providerSessionId !== expectedProviderSessionId) {
      return (await this.#abandonSwiftStudioSessionPreparation(row, reconciliationError)) ?? row
    }
    let expected: Readonly<SwiftStudioProviderExpectedExportV2>
    try {
      expected = await this.#measureSwiftStudioExport(
        row.datasetVersion,
        swiftStudioCountToSafeNumber(row.exportOutputCount),
        row.fidelityDigest,
        {},
      )
    } catch (error) {
      return (await this.#abandonSwiftStudioSessionPreparation(row, error)) ?? row
    }
    if (
      current.datasetVersion !== row.datasetVersion ||
      current.converter !== row.converter ||
      current.converterVersion !== row.converterVersion ||
      current.exportDigest !== expected.digest ||
      current.exportSizeBytes !== expected.sizeBytes ||
      current.outputCount !== expected.lineCount
    ) {
      const closed = await this.#closeSwiftStudioProviderAfterPreparationFailure(
        runtime.provider,
        expectedProviderSessionId,
        row.createDigest,
        reconciliationError,
      )
      if (!closed) {
        return (await this.#abandonSwiftStudioSessionPreparation(row, reconciliationError)) ?? row
      }
      return (
        (await this.#failSwiftStudioSession(row, reconciliationError, {
          phase: 'provider',
          code: 'export_mismatch',
          message: 'Provider export verification failed',
        })) ?? row
      )
    }

    try {
      return await this.#transitionSwiftStudioSessionReady(row, expected.digest, expected.sizeBytes)
    } catch {
      try {
        return (await runtime.catalog.getSwiftStudioSession(row.namespaceId, row.id)) ?? row
      } catch {
        return row
      }
    }
  }

  async #transitionSwiftStudioSessionReady(
    row: CatalogSwiftStudioSessionRowV2,
    exportDigest: string,
    exportSizeBytes: number,
  ): Promise<CatalogSwiftStudioSessionRowV2> {
    const runtime = this.#requireSwiftStudio()
    let lastError: unknown = new IntegrityError(
      'Swift Studio Session could not reach ready state',
      { reason: 'swift_studio_session_ready_transition', session_id: row.id },
    )
    let confirmedPreparing = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const ready = await runtime.catalog.transitionSwiftStudioSession({
          namespaceId: row.namespaceId,
          id: row.id,
          status: 'ready',
          preparationOwnerToken: row.preparationOwnerToken,
          exportDigest,
          exportSizeBytes: BigInt(exportSizeBytes),
        })
        if (ready === null) {
          throw new IntegrityError('Swift Studio Session disappeared during preparation', {
            reason: 'swift_studio_session_disappeared',
            session_id: row.id,
          })
        }
        this.#assertSwiftStudioNamespace(ready, row.namespaceId)
        return ready
      } catch (error) {
        lastError = error
        let existing: CatalogSwiftStudioSessionRowV2 | null
        try {
          existing = await runtime.catalog.getSwiftStudioSession(row.namespaceId, row.id)
        } catch (readError) {
          attachSuppressed(error, readError)
          break
        }
        if (existing === null) throw mapSwiftStudioCatalogError(error)
        this.#assertSwiftStudioNamespace(existing, row.namespaceId)
        if (existing.status === 'ready') {
          if (
            existing.exportDigest !== exportDigest ||
            existing.exportSizeBytes !== BigInt(exportSizeBytes)
          ) {
            throw new IntegrityError('Swift Studio Session ready export does not match Provider', {
              reason: 'swift_studio_session_ready_mismatch',
              session_id: row.id,
            })
          }
          return existing
        }
        if (existing.status !== 'preparing') throw mapSwiftStudioCatalogError(error)
        if (existing.preparationOwnerToken !== row.preparationOwnerToken) {
          throw new SwiftStudioSessionStateConflictErrorV2({
            reason: 'invalid_transition',
            session_id: existing.id,
            status: existing.status,
            requested_status: 'ready',
          })
        }
        confirmedPreparing = true
      }
    }

    if (confirmedPreparing) {
      await this.#abandonSwiftStudioSessionPreparation(row, lastError)
    }
    throw mapSwiftStudioCatalogError(lastError)
  }

  async #convergeClosedSwiftStudioSession(
    namespaceId: string,
    id: string,
  ): Promise<CatalogSwiftStudioSessionRowV2> {
    const runtime = this.#requireSwiftStudio()
    let current = await runtime.catalog.getSwiftStudioSession(namespaceId, id)
    let lastError: unknown = new IntegrityError(
      'Swift Studio Session could not reach closed state',
      { reason: 'swift_studio_session_close_transition', session_id: id },
    )
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (current === null) {
        throw new NotFoundError(`Swift Studio Session was not found: ${id}`, { session_id: id })
      }
      this.#assertSwiftStudioNamespace(current, namespaceId)
      if (current.status === 'closed') return current
      if (current.status !== 'ready' && current.status !== 'closing') {
        throw new SwiftStudioSessionStateConflictErrorV2({
          reason: 'invalid_transition',
          session_id: current.id,
          status: current.status,
          requested_status: 'closed',
        })
      }
      try {
        current = await runtime.catalog.transitionSwiftStudioSession({
          namespaceId,
          id,
          status: current.status === 'ready' ? 'closing' : 'closed',
        })
      } catch (error) {
        lastError = error
        try {
          current = await runtime.catalog.getSwiftStudioSession(namespaceId, id)
        } catch (readError) {
          attachSuppressed(error, readError)
          throw mapSwiftStudioCatalogError(error)
        }
      }
    }
    throw mapSwiftStudioCatalogError(lastError)
  }

  async #abandonSwiftStudioSessionPreparation(
    row: CatalogSwiftStudioSessionRowV2,
    primaryError: unknown,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null> {
    const runtime = this.#requireSwiftStudio()
    try {
      await runtime.catalog.abandonSwiftStudioSessionPreparation(
        row.namespaceId,
        row.id,
        row.preparationOwnerToken,
      )
      return await runtime.catalog.getSwiftStudioSession(row.namespaceId, row.id)
    } catch (abandonError) {
      attachSuppressed(primaryError, abandonError)
      return null
    }
  }

  #requireSwiftStudio(): Readonly<ResolvedV2SwiftStudioWorkspaceOptions> {
    if (this.#swiftStudio === null) {
      throw new ServiceUnavailableError('Swift Studio Session bridge is disabled', {
        dependency: 'swift_studio_provider',
      })
    }
    return this.#swiftStudio
  }

  #assertSwiftStudioNamespace(row: CatalogSwiftStudioSessionRowV2, namespaceId: string): void {
    if (row.namespaceId !== namespaceId) {
      throw new IntegrityError('Catalog returned a Swift Studio Session from another namespace', {
        reason: 'swift_studio_session_namespace_mismatch',
        session_id: row.id,
      })
    }
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
    const validatedPage = validateCatalogRefPage(
      page,
      namespaceId,
      afterName,
      request.limit,
      'active',
    )
    return RefPageV2Schema.parse({
      items: validatedPage.items,
      next_cursor:
        validatedPage.nextName === null
          ? null
          : this.#cursor.encodeRef(namespaceId, validatedPage.nextName),
    })
  }

  async listDeletedRefs(
    requestInput: CursorPageRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<DeletedRefPageV2> {
    context.signal?.throwIfAborted()
    const request = CursorPageRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    const afterName =
      request.cursor === null ? null : this.#cursor.decodeDeletedRef(request.cursor, namespaceId)
    context.signal?.throwIfAborted()
    let page: CatalogRefPageV2
    try {
      page = await waitWithAbort(
        this.#catalog.listDeletedRefs(namespaceId, afterName, request.limit),
        context.signal,
      )
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    const validatedPage = validateCatalogRefPage(
      page,
      namespaceId,
      afterName,
      request.limit,
      'deleted',
    )
    return DeletedRefPageV2Schema.parse({
      items: validatedPage.items,
      next_cursor:
        validatedPage.nextName === null
          ? null
          : this.#cursor.encodeDeletedRef(namespaceId, validatedPage.nextName),
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
    assertRefRow(row, namespaceId, name, row.version, 'active')
    return catalogRefMetadata(row)
  }

  async getDeletedRef(
    nameInput: string,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<DeletedRefMetadataV2 | null> {
    const name = RefNameV2Schema.parse(nameInput)
    const namespaceId = await this.#namespace(context.signal)
    context.signal?.throwIfAborted()
    let row: CatalogRefRowV2 | null
    try {
      row = await waitWithAbort(this.#catalog.getDeletedRef(namespaceId, name), context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      mapV2CatalogError(error, false)
    }
    if (row === null) return null
    assertRefRow(row, namespaceId, name, row.version, 'deleted')
    return catalogDeletedRefMetadata(row)
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
    assertRefRow(row, namespaceId, name, request.new_version, 'active')
    return catalogRefMetadata(row)
  }

  async deleteRef(
    nameInput: string,
    requestInput: DeleteRefRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<DeleteRefResultV2> {
    const name = RefNameV2Schema.parse(nameInput)
    const request = DeleteRefRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    context.signal?.throwIfAborted()
    let result: CatalogDeleteRefResultV2
    try {
      result = await this.#catalog.deleteRef({
        namespaceId,
        name,
        expectedVersion: request.expected_version,
      })
    } catch (error) {
      mapV2CatalogError(error, false)
    }
    if (result.status === 'missing') {
      throw new NotFoundError(`V2 ref was not found: ${name}`, { ref_name: name })
    }
    assertRefRow(result.row, namespaceId, name, request.expected_version, 'deleted')
    return DeleteRefResultV2Schema.parse({
      status: result.status,
      ref: catalogDeletedRefMetadata(result.row),
    })
  }

  async restoreRef(
    nameInput: string,
    requestInput: RestoreRefRequestV2,
    context: V2WorkspaceOperationOptions = {},
  ): Promise<RestoreRefResultV2> {
    const name = RefNameV2Schema.parse(nameInput)
    const request = RestoreRefRequestV2Schema.parse(requestInput)
    const namespaceId = await this.#namespace(context.signal)
    context.signal?.throwIfAborted()
    let result: CatalogRestoreRefResultV2
    try {
      result = await this.#catalog.restoreRef({
        namespaceId,
        name,
        expectedVersion: request.expected_version,
      })
    } catch (error) {
      mapV2CatalogError(error, false)
    }
    if (result.status === 'missing') {
      throw new NotFoundError(`V2 ref was not found: ${name}`, { ref_name: name })
    }
    assertRefRow(result.row, namespaceId, name, request.expected_version, 'active')
    return RestoreRefResultV2Schema.parse({
      status: result.status,
      ref: catalogRefMetadata(result.row),
    })
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

  async *#projectWorkerInput(
    job: CatalogTransformJobRowV2,
    signal: AbortSignal,
  ): AsyncIterableIterator<Uint8Array> {
    compileBasicCleanWorkerParametersV1(job)
    const expectedCount = workerCountToSafeNumber(job.inputCount, 'input_count')
    const resolved = await this.#resolveLayout(job.inputVersion, signal, true)
    const lease = await this.#acquire(resolved.identity, signal, true)
    try {
      signal.throwIfAborted()
      if (lease.dataset.version !== job.inputVersion || lease.dataset.length !== expectedCount) {
        throw new IntegrityError('Worker job input does not match its exact Dataset snapshot', {
          reason: 'worker_input_snapshot_mismatch',
          expected_dataset_version: job.inputVersion,
          actual_dataset_version: lease.dataset.version,
          expected_count: expectedCount,
          actual_count: lease.dataset.length,
        })
      }
      yield* writeWorkerRecordTextJsonlV1(lease.dataset.records(), { signal })
    } finally {
      lease.release()
    }
  }

  async #finalizeWorkerJob(
    context: WorkerFinalizationContext,
    staging: WorkerStagingStoreV1,
  ): Promise<void> {
    assertWorkerFinalizationContext(context)
    compileBasicCleanWorkerParametersV1(context.job)
    const terminal = requireWorkerOutput(context)
    const inputCount = workerCountToSafeNumber(context.job.inputCount, 'input_count')
    if (terminal.recordCount > inputCount) {
      throw new IntegrityError('Worker output count exceeds its exact input Dataset', {
        reason: 'worker_output_count_exceeds_input',
        input_count: inputCount,
        output_count: terminal.recordCount,
      })
    }

    let completed: CatalogTransformJobRowV2 | undefined
    let primaryError: unknown | null = null
    try {
      await this.#transformSemaphore.run(async (runSignal) => {
        const resolved = await this.#resolveLayout(context.job.inputVersion, runSignal, true)
        const inputLease = await this.#acquire(resolved.identity, runSignal, true)
        let output: V2Dataset
        try {
          runSignal.throwIfAborted()
          if (
            inputLease.dataset.version !== context.job.inputVersion ||
            inputLease.dataset.length !== inputCount
          ) {
            throw new IntegrityError('Worker finalizer loaded a different input Dataset', {
              reason: 'worker_finalizer_input_mismatch',
              expected_dataset_version: context.job.inputVersion,
              actual_dataset_version: inputLease.dataset.version,
              expected_count: inputCount,
              actual_count: inputLease.dataset.length,
            })
          }
          admitV2TransformWorkingSet(
            {
              inputDatasets: [inputLease.dataset],
              outputUpperBoundBytes: inputLease.dataset.canonicalBytes,
              frameEstimateBytes: 0,
            },
            this.#transformLimits.max_working_set_bytes,
          )
          const retained = await readWorkerRetainedJsonlV1(
            staging.readExact(
              {
                jobId: context.job.id,
                attempt: context.job.attempt,
                logicalName: 'output',
              },
              {
                expectedSize: terminal.size,
                expectedDigest: terminal.digest,
                signal: runSignal,
              },
            ),
            inputLease.dataset.records(),
            { terminal, signal: runSignal },
          )
          output = V2Dataset.fromRecords(
            retained.map((revision) => revision.record),
            this.#datasetLimits,
          )
          assertWorkerOutputPreservesRevisions(output, retained)
          admitV2TransformWorkingSet(
            {
              inputDatasets: [inputLease.dataset],
              outputUpperBoundBytes: output.canonicalBytes,
              frameEstimateBytes: 0,
            },
            this.#transformLimits.max_working_set_bytes,
          )
        } finally {
          inputLease.release()
        }

        const run: RegisterTransformResultV2['run'] = {
          id: `run_${context.job.cacheKey}`,
          cacheKey: context.job.cacheKey,
          op: context.job.op,
          opVersion: context.job.opVersion,
          params: context.job.params,
          inputVersions: [context.job.inputVersion],
          outputVersion: output.version,
        }
        const committed = await this.#commitCanonicalTransform(
          output,
          run,
          runSignal,
          async (registration) => {
            try {
              return await this.#catalog.completeTransformJob({
                ...registration,
                job: context.lease,
                outputCount: BigInt(output.length),
              })
            } catch (error) {
              if (error instanceof V2CatalogDeterminismConflictError) {
                await this.#throwTransformDeterminismConflict(run, runSignal)
              }
              mapV2CatalogError(error, true)
            }
          },
        )
        completed = committed.catalogResult

        const winning = await this.#findRun(context.job.cacheKey, runSignal, true)
        if (winning === null) {
          throw new IntegrityError('Completed Worker transform run cannot be read back', {
            reason: 'worker_transform_run_missing_after_complete',
            cache_key: context.job.cacheKey,
          })
        }
        validateRunRow(winning, {
          cacheKey: run.cacheKey,
          runId: run.id,
          op: run.op,
          opVersion: run.opVersion,
          inputVersions: run.inputVersions,
          params: run.params,
          outputVersion: output.version,
        })
        const verifiedManifest = await this.#verifyTransformOutput(output.version, runSignal)
        if (canonicalJsonV2(verifiedManifest) !== canonicalJsonV2(committed.manifest)) {
          throw new IntegrityError(
            'Completed Worker transform manifest changed after registration',
            {
              reason: 'worker_transform_manifest_readback_mismatch',
              dataset_version: output.version,
            },
          )
        }
      }, context.signal)
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      if (completed !== undefined) {
        await this.#cleanupCompletedWorkerStaging(completed, staging, primaryError)
      }
    }
  }

  async #cleanupCompletedWorkerStaging(
    job: CatalogTransformJobRowV2,
    staging: WorkerStagingStoreV1,
    primaryError: unknown | null,
  ): Promise<void> {
    const prefix = { jobId: job.id, attempt: job.attempt }
    const expectedInputKey = workerStagingKeyV1({ ...prefix, logicalName: 'input' })
    const expectedOutputKey = workerStagingKeyV1({ ...prefix, logicalName: 'output' })
    if (job.inputKey !== expectedInputKey || job.outputKey !== expectedOutputKey) {
      this.#reportCleanupError(
        new IntegrityError('Completed Worker job has invalid exact staging keys', {
          reason: 'worker_completed_staging_keys_invalid',
          job_id: job.id,
        }),
        primaryError,
      )
      return
    }
    const deleted = await Promise.allSettled([
      staging.deleteExact({ ...prefix, logicalName: 'input' }),
      staging.deleteExact({ ...prefix, logicalName: 'output' }),
    ])
    const failures = deleted.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length > 0) {
      this.#reportCleanupError(
        new AggregateError(failures, 'Completed Worker exact staging cleanup failed'),
        primaryError,
      )
      return
    }
    try {
      const cleared = await this.#catalog.clearCompletedTransformJobStagingKeys({
        id: job.id,
        attempt: job.attempt,
        outputVersion: requireCompletedWorkerOutputVersion(job),
        inputKey: expectedInputKey,
        outputKey: expectedOutputKey,
      })
      if (!cleared) throw new Error('Completed Worker staging keys were not cleared')
    } catch (error) {
      this.#reportCleanupError(error, primaryError)
    }
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
    const committed = await this.#commitCanonicalTransform(
      dataset,
      run,
      signal,
      async (registration) => {
        try {
          await this.#catalog.registerTransformResult(registration)
        } catch (error) {
          if (error instanceof V2CatalogDeterminismConflictError) {
            await this.#throwTransformDeterminismConflict(run, signal)
          }
          mapV2CatalogError(error, true)
        }
      },
    )
    const refUpdate = await this.#updateRefForCommittedDataset(dataset.version, request, signal)
    return { manifest: committed.manifest, refUpdate }
  }

  async #commitCanonicalTransform<T>(
    dataset: V2Dataset,
    run: RegisterTransformResultV2['run'],
    signal: AbortSignal,
    register: (input: RegisterTransformResultV2) => Promise<T>,
  ): Promise<{ readonly manifest: Readonly<DatasetManifestV2>; readonly catalogResult: T }> {
    let prepared: PreparedArtifactV2 | undefined
    let result:
      | { readonly manifest: Readonly<DatasetManifestV2>; readonly catalogResult: T }
      | undefined
    let failed = false
    let failure: unknown
    try {
      signal.throwIfAborted()
      prepared = await this.#store.prepare(dataset, { signal })
      const manifest = await this.#store.commit(prepared, { signal })
      const registration = { ...registrationFromCommittedDataset(dataset, manifest), run }
      const catalogResult = await register(registration)
      result = { manifest, catalogResult }
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
      throw new IntegrityError('V2 transform commit completed without a result', {
        reason: 'transform_commit_result_missing',
      })
    }
    return result
  }

  async #throwTransformDeterminismConflict(
    run: RegisterTransformResultV2['run'],
    signal: AbortSignal,
  ): Promise<never> {
    // The read-after-conflict is still a Catalog dependency call. Route it
    // through the ordinary cache lookup boundary instead of trusting the
    // losing registration attempt or leaking a raw driver error.
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
      throw new IntegrityError('V2 Catalog reported a conflict for an identical transform run', {
        reason: 'transform_conflict_for_identical_run',
        cache_key: run.cacheKey,
      })
    }
    throw new DeterminismConflictErrorV2({
      cache_key: run.cacheKey,
      existing_output_version: existingRun.output_dataset_version,
      attempted_output_version: run.outputVersion,
      attempted_dataset_committed: true,
    })
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
    assertRefRow(ref, namespaceId, request.ref, datasetVersion, 'active')
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
        let ref: CatalogRefRowV2 | undefined
        try {
          ref = await this.#catalog.compareAndSetRef({
            namespaceId,
            name: options.ref,
            newVersion: dataset.version,
            expectedVersion: options.expected_ref_version,
            message: options.message,
          })
        } catch (error) {
          if (
            error instanceof V2CatalogRefConflictError &&
            error.currentVersion === dataset.version
          ) {
            const replayed = await this.getRef(options.ref, signal === undefined ? {} : { signal })
            if (replayed?.version === dataset.version && replayed.message === options.message) {
              refUpdate = {
                status: 'updated',
                ref_name: replayed.name,
                previous_version: options.expected_ref_version,
                current_version: replayed.version,
              }
            } else {
              mapV2CatalogError(error, true)
            }
          } else {
            mapV2CatalogError(error, true)
          }
        }
        if (ref !== undefined) {
          assertRefRow(ref, namespaceId, options.ref, dataset.version, 'active')
          refUpdate = {
            status: 'updated',
            ref_name: ref.name,
            previous_version: options.expected_ref_version,
            current_version: ref.version,
          }
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
      assertRefRow(ref, namespaceId, requestedRef, ref.version, 'active')
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

function evaluationTransitionBodyMatches(
  run: EvaluationRunV2,
  input: TransitionEvaluationRunV2,
): boolean {
  if (input.status === 'running') return true
  if (input.status === 'completed') {
    return (
      canonicalJsonV2(run.metrics) ===
        canonicalJsonV2(
          input.metrics.map((metric) => ({
            dataset: metric.dataset,
            subset: metric.subset,
            metric: metric.metric,
            score: metric.score,
            sample_count: metric.sampleCount,
            categories: metric.categories,
          })),
        ) && canonicalJsonV2(run.provider_report_ids) === canonicalJsonV2(input.providerReportIds)
    )
  }
  return canonicalJsonV2(run.error) === canonicalJsonV2(input.error)
}

function requireExactDatasetVersion(input: string): string {
  return DigestHexV2Schema.parse(input)
}

function transformJobCatalogCursor(state: {
  readonly created_at: string
  readonly id: string
}): CatalogTransformJobCursorV2 {
  return Object.freeze({ createdAt: new Date(state.created_at), id: state.id })
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
  state: 'active' | 'deleted',
): void {
  if (
    row.namespaceId !== namespaceId ||
    row.name !== name ||
    row.version !== version ||
    !EXACT_VERSION.test(row.version) ||
    (state === 'active' ? row.deletedAt !== null : row.deletedAt === null) ||
    (row.deletedAt !== null && !Number.isFinite(row.deletedAt.getTime()))
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

function catalogDeletedRefMetadata(row: CatalogRefRowV2): DeletedRefMetadataV2 {
  try {
    return deletedRefMetadataFromCatalog(row)
  } catch (error) {
    throw new IntegrityError('Stored deleted V2 ref metadata is inconsistent', {
      reason: 'catalog_deleted_ref_invalid',
      cause: error instanceof Error ? error.name : typeof error,
    })
  }
}

function validateCatalogRefPage(
  page: CatalogRefPageV2,
  namespaceId: string,
  afterName: string | null,
  limit: number,
  state: 'active' | 'deleted',
): {
  readonly items: readonly (DeletedRefMetadataV2 | RefMetadataV2)[]
  readonly nextName: string | null
} {
  if (page.rows.length > limit) {
    throw new IntegrityError('V2 Catalog returned too many refs', {
      reason: 'catalog_ref_page_oversized',
      limit,
      actual: page.rows.length,
    })
  }
  const items: Array<DeletedRefMetadataV2 | RefMetadataV2> = []
  let previousName = afterName
  for (const row of page.rows) {
    if (row.namespaceId !== namespaceId || (previousName !== null && row.name <= previousName)) {
      throw new IntegrityError('V2 Catalog returned an invalid ref page order', {
        reason: 'catalog_ref_page_order',
      })
    }
    assertRefRow(row, namespaceId, row.name, row.version, state)
    items.push(state === 'active' ? catalogRefMetadata(row) : catalogDeletedRefMetadata(row))
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
  return fitPreviewResult(input, requestedRecords, maxResponseBytes, (value) =>
    McpCanonicalValidationPreviewResultSchema.parse(value),
  )
}

function fitPreviewResult<
  T extends {
    readonly record_count: number
    readonly records: readonly unknown[]
    readonly records_truncated: boolean
  },
>(
  input: T,
  requestedRecords: number,
  maxResponseBytes: number,
  parse: (input: unknown) => T,
): Readonly<T> {
  const records = [...input.records]
  while (true) {
    const result = parse({
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

async function* canonicalPreviewRecordsFromDrafts(
  source: AsyncIterable<CanonicalDraftRecordV1>,
  previewDrafts: CanonicalDraftRecordV1[],
  limit: number,
  onRecord: () => void,
): AsyncIterableIterator<PostTrainingRecordV2> {
  let dataRowIndex = 0
  for await (const draft of source) {
    onRecord()
    if (previewDrafts.length < limit) previewDrafts.push(draft)
    yield PostTrainingRecordV2Schema.parse(canonicalPreviewRecordFromDraftV1(draft, dataRowIndex))
    dataRowIndex += 1
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
    ...(input.swiftStudio === undefined
      ? {}
      : { swiftStudio: snapshotSwiftStudioWorkspaceOpenOptions(input.swiftStudio) }),
  })
}

function snapshotSwiftStudioWorkspaceOpenOptions(
  input: V2SwiftStudioWorkspaceOpenOptions,
): Readonly<V2SwiftStudioWorkspaceOpenOptions> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Swift Studio Workspace open options must be an object')
  }
  const providerBaseUrl = requireHttpOrigin('Swift Studio Provider base URL', input.providerBaseUrl)
  const datasetExportBaseUrl = requireHttpOrigin(
    'Swift Studio Dataset export base URL',
    input.datasetExportBaseUrl,
  )
  const identity = snapshotSwiftStudioIdentity(input)
  return Object.freeze({
    providerBaseUrl,
    datasetExportBaseUrl,
    ...identity,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
}

function snapshotSwiftStudioWorkspaceOptions(
  input: V2SwiftStudioWorkspaceOptions,
): Readonly<ResolvedV2SwiftStudioWorkspaceOptions> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Swift Studio Workspace options must be an object')
  }
  if (input.catalog === null || typeof input.catalog !== 'object') {
    throw new TypeError('Swift Studio Catalog is required')
  }
  if (input.provider === null || typeof input.provider !== 'object') {
    throw new TypeError('Swift Studio Provider is required')
  }
  return Object.freeze({
    catalog: input.catalog,
    provider: input.provider,
    datasetExportBaseUrl: requireHttpOrigin(
      'Swift Studio Dataset export base URL',
      input.datasetExportBaseUrl,
    ),
    ...snapshotSwiftStudioIdentity(input),
    preparationAbandonGraceMs: nonnegativeSafeInteger(
      'Swift Studio preparation abandon grace',
      input.preparationAbandonGraceMs ?? DEFAULT_SWIFT_STUDIO_ABANDON_GRACE_MS,
    ),
  })
}

function snapshotSwiftStudioIdentity(input: {
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly runtimeCapabilityDigest: string
}): {
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly runtimeCapabilityDigest: string
} {
  if (!/^[0-9a-f]{40}$/u.test(input.upstreamCommit)) {
    throw new TypeError('Swift Studio upstream commit must be lowercase 40-hex')
  }
  if (!EXACT_VERSION.test(input.imageDigest)) {
    throw new TypeError('Swift Studio image digest must be lowercase 64-hex')
  }
  if (!EXACT_VERSION.test(input.runtimeCapabilityDigest)) {
    throw new TypeError('Swift Studio capability digest must be lowercase 64-hex')
  }
  return Object.freeze({
    upstreamCommit: input.upstreamCommit,
    imageDigest: input.imageDigest,
    runtimeCapabilityDigest: input.runtimeCapabilityDigest,
  })
}

function requireHttpOrigin(name: string, value: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`${name} must be an HTTP origin`)
  }
  return url.origin
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

function assertWorkerFinalizationContext(context: WorkerFinalizationContext): void {
  if (
    context.job.id !== context.lease.id ||
    context.job.attempt !== context.lease.attempt ||
    !sameByteSequence(context.job.leaseToken, context.lease.leaseToken)
  ) {
    throw new IntegrityError('Worker finalizer context does not match its exact job lease', {
      reason: 'worker_finalizer_lease_mismatch',
    })
  }
}

function requireWorkerOutput(context: WorkerFinalizationContext): WorkerRetainedTerminalV1 {
  const output = context.outputs[0]
  if (context.outputs.length !== 1 || output?.name !== 'output') {
    throw new IntegrityError('Worker completion must contain exactly one named output', {
      reason: 'worker_terminal_output_shape',
    })
  }
  return {
    size: output.size,
    digest: output.digest,
    recordCount: output.recordCount,
  }
}

function assertWorkerOutputPreservesRevisions(
  output: V2Dataset,
  retained: readonly RecordRevisionV2[],
): void {
  if (output.length !== retained.length) {
    throw new IntegrityError('Worker output Dataset count changed during canonical construction', {
      reason: 'worker_output_dataset_count_mismatch',
    })
  }
  for (const expected of retained) {
    const actual = output.get(expected.record.id)
    if (
      actual?.record_digest !== expected.record_digest ||
      actual.record_json !== expected.record_json
    ) {
      throw new IntegrityError('Worker output changed an original canonical record revision', {
        reason: 'worker_output_revision_changed',
        record_id: expected.record.id,
      })
    }
  }
}

function workerCountToSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError(`Worker job ${field} is outside the safe integer range`, {
      reason: 'worker_job_count_out_of_range',
      field,
      actual: value.toString(),
    })
  }
  return Number(value)
}

function swiftStudioCountToSafeNumber(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError('Swift Studio export count is outside the safe integer range', {
      reason: 'swift_studio_export_count_out_of_range',
      actual: value.toString(),
    })
  }
  return Number(value)
}

function mapSwiftStudioCatalogError(error: unknown): Error {
  if (error instanceof V2CatalogSwiftStudioSessionConflictError) {
    return new SwiftStudioSessionStateConflictErrorV2({
      reason: error.reason,
      session_id: error.sessionId,
      status: error.status,
      requested_status: error.requestedStatus,
    })
  }
  return mapV2CatalogError(error, false)
}

function swiftStudioExportUrl(baseUrl: string, datasetVersion: string): string {
  const version = DigestHexV2Schema.parse(datasetVersion)
  return new URL(`/v2/datasets/${version}:export`, baseUrl).toString()
}

function checkedAddSafeInteger(left: number, right: number, name: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new CapacityExceededError(`${name} exceeds the safe integer range`, {
      resource: 'swift_studio_export_bytes',
    })
  }
  return left + right
}

function requireCompletedWorkerOutputVersion(job: CatalogTransformJobRowV2): string {
  if (job.status !== 'completed' || job.outputVersion === null) {
    throw new IntegrityError('Worker staging cleanup requires a completed canonical job', {
      reason: 'worker_cleanup_job_not_completed',
      job_id: job.id,
    })
  }
  return job.outputVersion
}

function sameByteSequence(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false
  return left.every((value, index) => value === right[index])
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

function nonnegativeSafeInteger(name: string, value: number): number {
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
