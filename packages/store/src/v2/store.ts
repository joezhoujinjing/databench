import type { FileHandle } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import {
  DEFAULT_V2_DATASET_LIMITS,
  decodeRecordJsonV1FromFileHandle,
  hashV2ArtifactFileHandle,
  type V2ArtifactFileDigest,
  V2Dataset,
  type V2DatasetLimits,
  writeRecordJsonV1ToFileHandle,
} from '@databench/engine'
import { createArtifactHasher } from '@databench/hashing'
import {
  CapacityExceededError,
  ConflictError,
  canonicalDatasetManifestV2Bytes,
  createDatasetManifestV2,
  type DatasetLayoutIdentityV2,
  DatasetLayoutIdentityV2Schema,
  type DatasetManifestV2,
  DomainError,
  datasetLayoutIdentityV2FromManifest,
  IntegrityError,
  ManifestIntegrityErrorV2,
  NotFoundError,
  parseStoredDatasetManifestV2,
  V2_MANIFEST_MAX_BYTES,
  V2_RECORD_JSON_LAYOUT_VERSION,
} from '@databench/schema'
import type {
  AuditResultV2,
  ConditionalCreateResult,
  ConditionalObjectStoreV2,
  PreparedArtifactV2,
  V2OperationContext,
  V2Store,
} from './contracts.js'
import { LayoutConflictErrorV2, ObjectStoreFailureErrorV2 } from './contracts.js'
import { v2ObjectKeys } from './keys.js'
import { SemaphoreV2, throwIfAborted } from './runtime.js'
import {
  DEFAULT_V2_TEMP_SAFETY_MARGIN_BYTES,
  DEFAULT_V2_TEMP_STALE_AGE_MS,
  type V2TempFile,
  type V2TempReservation,
  V2TempStore,
} from './temp-store.js'

const MEBIBYTE = 1024 * 1024
const V2_PREPARE_FIXED_OVERHEAD_BYTES = 64 * MEBIBYTE
const V2_PREPARE_PER_RECORD_OVERHEAD_BYTES = 256
const DEFAULT_V2_PREPARE_CONCURRENCY = 2
const DEFAULT_V2_READ_CONCURRENCY = 2

type PreparedState =
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'discarding'
  | 'cleanup_failed'
  | 'discarded'

interface PreparedArtifactV2Internal {
  readonly file: V2TempFile
  readonly reservation: V2TempReservation
  readonly owner: object
  state: PreparedState
}

const preparedArtifactInternals = new WeakMap<PreparedArtifactV2Impl, PreparedArtifactV2Internal>()

export interface FileBackedV2StoreConfig {
  readonly objectStore: ConditionalObjectStoreV2
  readonly tempRoot: string
  readonly staleAgeMs?: number
  readonly safetyMarginBytes?: number
  readonly prepareConcurrency?: number
  readonly readConcurrency?: number
  readonly datasetLimits?: V2DatasetLimits
}

class PreparedArtifactV2Impl {
  readonly identity: Readonly<DatasetLayoutIdentityV2>
  readonly manifest: Readonly<DatasetManifestV2>

  constructor(
    owner: object,
    identity: Readonly<DatasetLayoutIdentityV2>,
    manifest: Readonly<DatasetManifestV2>,
    file: V2TempFile,
    reservation: V2TempReservation,
  ) {
    this.identity = identity
    this.manifest = manifest
    preparedArtifactInternals.set(this, {
      owner,
      file,
      reservation,
      state: 'prepared',
    })
    Object.freeze(this)
  }
}

export class FileBackedV2Store implements V2Store {
  readonly #objectStore: ConditionalObjectStoreV2
  readonly #temp: V2TempStore
  readonly #prepareSemaphore: SemaphoreV2
  readonly #readSemaphore: SemaphoreV2
  // Decoding one upper-bound dataset can already occupy more than 512 MiB once
  // JS objects are included. Keep the public read admission at the locked
  // default of two, but serialize the heap-heavy decode phase by default.
  readonly #decodeMemoryGate = new SemaphoreV2(1)
  readonly #datasetLimits: Readonly<V2DatasetLimits>
  readonly #owner = Object.freeze({})

  constructor(config: FileBackedV2StoreConfig) {
    if (!config.objectStore || typeof config.objectStore !== 'object') {
      throw new TypeError('objectStore must implement ConditionalObjectStoreV2')
    }
    this.#objectStore = config.objectStore
    this.#temp = new V2TempStore({
      tempRoot: config.tempRoot,
      staleAgeMs: config.staleAgeMs ?? DEFAULT_V2_TEMP_STALE_AGE_MS,
      safetyMarginBytes: config.safetyMarginBytes ?? DEFAULT_V2_TEMP_SAFETY_MARGIN_BYTES,
    })
    this.#prepareSemaphore = new SemaphoreV2(
      positiveSafeInteger(
        'prepareConcurrency',
        config.prepareConcurrency ?? DEFAULT_V2_PREPARE_CONCURRENCY,
      ),
    )
    this.#readSemaphore = new SemaphoreV2(
      positiveSafeInteger('readConcurrency', config.readConcurrency ?? DEFAULT_V2_READ_CONCURRENCY),
    )
    this.#datasetLimits = snapshotDatasetLimits(config.datasetLimits ?? DEFAULT_V2_DATASET_LIMITS)
  }

  async prepare(dataset: V2Dataset, context: V2OperationContext = {}): Promise<PreparedArtifactV2> {
    if (!(dataset instanceof V2Dataset)) {
      throw new TypeError('V2 Store prepare requires a V2Dataset')
    }
    const releaseConcurrency = await this.#prepareSemaphore.acquire(context.signal)
    let reservation: V2TempReservation | undefined
    let file: V2TempFile | undefined
    try {
      throwIfAborted(context.signal)
      const reservationBytes = estimatePrepareReservation(dataset)
      reservation = await this.#temp.reserve(reservationBytes, context.signal)
      file = await this.#temp.create('prepare', context.signal)
      const artifact = await writeRecordJsonV1ToFileHandle(dataset, file.handle, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      if (artifact.artifactSizeBytes > reservationBytes) {
        throw new CapacityExceededError('Prepared V2 artifact exceeded its disk reservation', {
          resource: 'temp_disk_bytes',
          limit: reservationBytes,
          actual: artifact.artifactSizeBytes,
        })
      }
      const identity = DatasetLayoutIdentityV2Schema.parse({
        ...dataset.identity,
        layout_version: V2_RECORD_JSON_LAYOUT_VERSION,
        artifact_digest: artifact.artifactDigest,
        artifact_size_bytes: artifact.artifactSizeBytes,
      })
      const manifest = createDatasetManifestV2(identity)
      canonicalDatasetManifestV2Bytes(manifest)
      return new PreparedArtifactV2Impl(
        this.#owner,
        Object.freeze(identity),
        manifest,
        file,
        reservation,
      ) as unknown as PreparedArtifactV2
    } catch (error) {
      try {
        if (file) await this.#temp.remove(file)
      } finally {
        reservation?.release()
      }
      throw error
    } finally {
      releaseConcurrency()
    }
  }

  async commit(
    preparedInput: PreparedArtifactV2,
    context: V2OperationContext = {},
  ): Promise<Readonly<DatasetManifestV2>> {
    const { prepared, internal } = this.#ownedPrepared(preparedInput)
    throwIfAborted(context.signal)
    if (internal.state === 'committed') return prepared.manifest
    if (internal.state === 'discarded') {
      throw new ConflictError('Prepared V2 artifact has already been discarded')
    }
    if (internal.state === 'committing') {
      throw new ConflictError('Prepared V2 artifact is already being committed')
    }
    if (internal.state === 'discarding' || internal.state === 'cleanup_failed') {
      throw new ConflictError('Prepared V2 artifact cleanup has already started')
    }

    internal.state = 'committing'
    try {
      await assertLocalArtifact(prepared, internal, context.signal)
      const keys = v2ObjectKeys(prepared.identity)
      await this.#commitArtifact(keys.artifact, prepared, internal, context.signal)
      await assertLocalArtifact(prepared, internal, context.signal)
      await this.#commitManifest(keys.manifest, prepared, context.signal)
      internal.state = 'committed'
      return prepared.manifest
    } catch (error) {
      internal.state = 'prepared'
      throw error
    }
  }

  async discard(
    preparedInput: PreparedArtifactV2,
    cleanupContext: V2OperationContext = {},
  ): Promise<void> {
    const { internal } = this.#ownedPrepared(preparedInput)
    if (internal.state === 'discarded') return
    throwIfAborted(cleanupContext.signal)
    if (internal.state === 'committing') {
      throw new ConflictError('Cannot discard a V2 artifact while commit is in progress')
    }
    if (internal.state === 'discarding') {
      throw new ConflictError('Prepared V2 artifact is already being discarded')
    }
    internal.state = 'discarding'
    try {
      await this.#temp.remove(internal.file)
      internal.reservation.release()
      internal.state = 'discarded'
    } catch (error) {
      internal.state = 'cleanup_failed'
      throw error
    }
  }

  async exists(
    identityInput: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<boolean> {
    const identity = DatasetLayoutIdentityV2Schema.parse(identityInput)
    const keys = v2ObjectKeys(identity)
    const manifest = await this.#readManifest(keys.manifest, identity, 'read', context.signal)
    if (manifest === null) return false
    const artifact = await this.#objectStore.head(keys.artifact, operationContext(context.signal))
    if (artifact === null) {
      throw new IntegrityError('Committed V2 manifest references a missing artifact', {
        reason: 'artifact_missing',
      })
    }
    if (artifact.size !== manifest.artifact_size_bytes) {
      throw new IntegrityError('Committed V2 artifact size does not match its manifest', {
        reason: 'artifact_size_mismatch',
        expected: manifest.artifact_size_bytes,
        actual: artifact.size,
      })
    }
    return true
  }

  async read(
    identity: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<V2Dataset> {
    return (await this.#load(identity, context.signal)).dataset
  }

  async audit(
    identity: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<AuditResultV2> {
    const loaded = await this.#load(identity, context.signal)
    return Object.freeze({ ok: true, identity: loaded.identity, manifest: loaded.manifest })
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    await this.#temp.initialize()
    await this.#objectStore.ping(context)
  }

  #ownedPrepared(input: PreparedArtifactV2): {
    readonly prepared: PreparedArtifactV2Impl
    readonly internal: PreparedArtifactV2Internal
  } {
    if (!(input instanceof PreparedArtifactV2Impl)) {
      throw new TypeError('Prepared V2 artifact does not belong to this Store instance')
    }
    const internal = preparedArtifactInternals.get(input)
    if (!internal || internal.owner !== this.#owner) {
      throw new TypeError('Prepared V2 artifact does not belong to this Store instance')
    }
    return { prepared: input, internal }
  }

  async #commitArtifact(
    key: string,
    prepared: PreparedArtifactV2Impl,
    internal: PreparedArtifactV2Internal,
    signal?: AbortSignal,
  ): Promise<void> {
    const create = async (): Promise<ConditionalCreateResult> => {
      const upload = new FileHandleSliceReadable(
        internal.file.handle,
        prepared.identity.artifact_size_bytes,
        signal,
      )
      try {
        const result = await this.#objectStore.conditionalCreate({
          key,
          contentType: 'application/vnd.apache.parquet',
          contentLength: prepared.identity.artifact_size_bytes,
          body: () => upload,
          ...(signal === undefined ? {} : { signal }),
        })
        if (result.status === 'created') {
          assertArtifactIdentity(upload.result(), prepared.identity)
        }
        return result
      } finally {
        upload.destroy()
      }
    }
    const verify = (probeSignal?: AbortSignal): Promise<'present' | 'absent'> =>
      this.#verifyRemoteArtifact(key, prepared.identity, probeSignal)
    await resolveConditionalCreate('artifact', create, verify, signal)
  }

  async #commitManifest(
    key: string,
    prepared: PreparedArtifactV2Impl,
    signal?: AbortSignal,
  ): Promise<void> {
    const bytes = canonicalDatasetManifestV2Bytes(prepared.manifest)
    const create = (): Promise<ConditionalCreateResult> =>
      this.#objectStore.conditionalCreate({
        key,
        contentType: 'application/json',
        contentLength: bytes.byteLength,
        body: () => Readable.from([bytes]),
        ...(signal === undefined ? {} : { signal }),
      })
    const verify = async (probeSignal?: AbortSignal): Promise<'present' | 'absent'> => {
      const existing = await this.#readManifest(key, prepared.identity, 'commit', probeSignal)
      return existing === null ? 'absent' : 'present'
    }
    await resolveConditionalCreate('manifest', create, verify, signal)
  }

  async #verifyRemoteArtifact(
    key: string,
    identity: Readonly<DatasetLayoutIdentityV2>,
    signal?: AbortSignal,
  ): Promise<'present' | 'absent'> {
    const head = await this.#objectStore.head(key, operationContext(signal))
    if (head === null) return 'absent'
    if (head.size !== identity.artifact_size_bytes) {
      throw new IntegrityError('Existing V2 artifact has an unexpected size', {
        reason: 'artifact_size_mismatch',
        expected: identity.artifact_size_bytes,
        actual: head.size,
      })
    }

    const sink = new ArtifactHashSink(identity.artifact_size_bytes, signal)
    const downloaded = await this.#objectStore.download({
      key,
      destination: sink,
      ...(signal === undefined ? {} : { signal }),
    })
    if (downloaded === 'not_found') {
      sink.destroy()
      throw new IntegrityError('Existing V2 artifact disappeared during verification', {
        reason: 'artifact_missing',
      })
    }
    const actual = sink.result()
    if (
      actual.artifactSizeBytes !== identity.artifact_size_bytes ||
      actual.artifactDigest !== identity.artifact_digest
    ) {
      throw new IntegrityError('Existing V2 artifact digest does not match its identity', {
        reason: 'artifact_digest_mismatch',
        expected: identity.artifact_digest,
        actual: actual.artifactDigest,
      })
    }
    return 'present'
  }

  async #readManifest(
    key: string,
    expected: Readonly<DatasetLayoutIdentityV2>,
    mode: 'commit' | 'read',
    signal?: AbortSignal,
  ): Promise<Readonly<DatasetManifestV2> | null> {
    const sink = new BoundedBufferSink(V2_MANIFEST_MAX_BYTES)
    const downloaded = await this.#objectStore.download({
      key,
      destination: sink,
      ...(signal === undefined ? {} : { signal }),
    })
    if (downloaded === 'not_found') {
      sink.destroy()
      return null
    }
    const manifest = parseStoredDatasetManifestV2(sink.bytes())
    const actual = datasetLayoutIdentityV2FromManifest(manifest)
    const actualKeys = v2ObjectKeys(actual)
    if (actualKeys.manifest !== key) {
      throw new IntegrityError('Stored V2 manifest is located under the wrong key', {
        reason: 'manifest_key_mismatch',
      })
    }
    if (!sameLayoutIdentity(actual, expected)) {
      if (mode === 'commit') throw new LayoutConflictErrorV2()
      throw new IntegrityError('Stored V2 manifest does not match the requested layout identity', {
        reason: 'manifest_identity_mismatch',
      })
    }
    return manifest
  }

  async #load(
    identityInput: DatasetLayoutIdentityV2,
    signal?: AbortSignal,
  ): Promise<{
    readonly dataset: V2Dataset
    readonly identity: Readonly<DatasetLayoutIdentityV2>
    readonly manifest: Readonly<DatasetManifestV2>
  }> {
    const identity = Object.freeze(DatasetLayoutIdentityV2Schema.parse(identityInput))
    const keys = v2ObjectKeys(identity)
    const manifest = await this.#readManifest(keys.manifest, identity, 'read', signal)
    if (manifest === null) {
      throw new NotFoundError('V2 dataset layout is not committed', {
        dataset_version: identity.dataset_version,
        layout_version: identity.layout_version,
      })
    }
    const head = await this.#objectStore.head(keys.artifact, operationContext(signal))
    if (head === null) {
      throw new IntegrityError('Committed V2 manifest references a missing artifact', {
        reason: 'artifact_missing',
      })
    }
    if (head.size !== identity.artifact_size_bytes) {
      throw new IntegrityError('Committed V2 artifact size does not match its manifest', {
        reason: 'artifact_size_mismatch',
        expected: identity.artifact_size_bytes,
        actual: head.size,
      })
    }

    const releaseRead = await this.#readSemaphore.acquire(signal)
    let releaseDecodeMemory: (() => void) | undefined
    let reservation: V2TempReservation | undefined
    let file: V2TempFile | undefined
    try {
      reservation = await this.#temp.reserve(identity.artifact_size_bytes, signal)
      file = await this.#temp.create('read', signal)
      const sink = new ArtifactFileSink(file.handle, identity.artifact_size_bytes, signal)
      const downloaded = await this.#objectStore.download({
        key: keys.artifact,
        destination: sink,
        ...(signal === undefined ? {} : { signal }),
      })
      if (downloaded === 'not_found') {
        sink.destroy()
        throw new IntegrityError('Committed V2 artifact disappeared during download', {
          reason: 'artifact_missing',
        })
      }
      const artifact = sink.result()
      assertArtifactIdentity(artifact, identity)
      releaseDecodeMemory = await this.#decodeMemoryGate.acquire(signal)
      const dataset = await decodeRecordJsonV1FromFileHandle(file.handle, {
        expectedIdentity: {
          identity_profile: identity.identity_profile,
          record_schema_version: identity.record_schema_version,
          dataset_version: identity.dataset_version,
          num_records: identity.num_records,
        },
        limits: this.#datasetLimits,
        ...(signal === undefined ? {} : { signal }),
      })
      return Object.freeze({ dataset, identity, manifest })
    } finally {
      try {
        if (file) await this.#temp.remove(file)
      } finally {
        reservation?.release()
        releaseDecodeMemory?.()
        releaseRead()
      }
    }
  }
}

async function resolveConditionalCreate(
  kind: 'artifact' | 'manifest',
  create: () => Promise<ConditionalCreateResult>,
  verify: (signal?: AbortSignal) => Promise<'present' | 'absent'>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  let result = await attemptConditionalCreate(create, signal)
  if (result.status === 'created') return
  if (result.status === 'failure') {
    throw new ObjectStoreFailureErrorV2(`Unable to conditionally create V2 ${kind}`, result.error)
  }
  const probeSignal = signal?.aborted ? undefined : signal
  if (result.status === 'already_exists') {
    const state = await verify(probeSignal)
    if (state === 'present') return
    throw new IntegrityError(`V2 ${kind} was reported as existing but could not be verified`, {
      reason: `${kind}_missing_after_already_exists`,
    })
  }

  if ((await verify(probeSignal)) === 'present') return
  throwIfAborted(signal)
  result = await attemptConditionalCreate(create, signal)
  if (result.status === 'created') return
  if (result.status === 'failure') {
    throw new ObjectStoreFailureErrorV2(
      `Unable to retry conditional creation of V2 ${kind}`,
      result.error,
    )
  }
  if ((await verify(signal?.aborted ? undefined : signal)) === 'present') return
  if (result.status === 'already_exists') {
    throw new IntegrityError(`V2 ${kind} disappeared after a conditional conflict`, {
      reason: `${kind}_missing_after_already_exists`,
    })
  }
  throw new ObjectStoreFailureErrorV2(
    `Conditional creation of V2 ${kind} remained ambiguous after one retry`,
    result.error,
  )
}

async function attemptConditionalCreate(
  create: () => Promise<ConditionalCreateResult>,
  signal?: AbortSignal,
): Promise<ConditionalCreateResult> {
  try {
    return await create()
  } catch (error) {
    if (signal?.aborted && isAbortFailure(error)) {
      return { status: 'ambiguous', error }
    }
    if (error instanceof DomainError) throw error
    return { status: 'failure', error }
  }
}

function isAbortFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      ('code' in error && (error as { readonly code?: unknown }).code === 'ABORT_ERR'))
  )
}

class BoundedBufferSink extends Writable {
  readonly #limit: number
  readonly #chunks: Buffer[] = []
  #size = 0

  constructor(limit: number) {
    super()
    this.#limit = limit
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    if (bytes.byteLength > this.#limit - this.#size) {
      callback(new ManifestIntegrityErrorV2('manifest_byte_limit_exceeded'))
      return
    }
    this.#chunks.push(Buffer.from(bytes))
    this.#size += bytes.byteLength
    callback()
  }

  bytes(): Uint8Array {
    if (!this.writableFinished) {
      throw new IntegrityError('Manifest download did not finish', {
        reason: 'manifest_download_incomplete',
      })
    }
    return Buffer.concat(this.#chunks, this.#size)
  }
}

class FileHandleSliceReadable extends Readable {
  readonly #handle: FileHandle
  readonly #length: number
  readonly #signal: AbortSignal | undefined
  readonly #hasher = createArtifactHasher()
  #offset = 0
  #reading = false
  #ended = false

  constructor(handle: FileHandle, length: number, signal?: AbortSignal) {
    super()
    this.#handle = handle
    this.#length = length
    this.#signal = signal
  }

  override _read(requestedSize: number): void {
    if (this.#reading || this.destroyed) return
    if (this.#offset >= this.#length) {
      this.#ended = true
      this.push(null)
      return
    }
    this.#reading = true
    const size = Math.min(Math.max(requestedSize, 64 * 1024), this.#length - this.#offset)
    const buffer = Buffer.allocUnsafe(size)
    const position = this.#offset
    this.#handle
      .read(buffer, 0, size, position)
      .then(({ bytesRead }) => {
        this.#reading = false
        if (this.destroyed) return
        throwIfAborted(this.#signal)
        if (bytesRead === 0) {
          this.destroy(new IntegrityError('Prepared V2 artifact ended during upload'))
          return
        }
        this.#offset += bytesRead
        const bytes = buffer.subarray(0, bytesRead)
        this.#hasher.update(bytes)
        this.push(bytes)
      })
      .catch((error: unknown) => {
        this.#reading = false
        this.destroy(asError(error))
      })
  }

  result(): Readonly<V2ArtifactFileDigest> {
    if (!this.#ended || this.#offset !== this.#length) {
      throw new IntegrityError('V2 artifact upload body was not consumed completely', {
        reason: 'artifact_upload_incomplete',
        expected: this.#length,
        actual: this.#offset,
      })
    }
    return Object.freeze({
      artifactDigest: this.#hasher.digestHex(),
      artifactSizeBytes: this.#offset,
    })
  }
}

class ArtifactHashSink extends Writable {
  readonly #expectedSize: number
  readonly #signal: AbortSignal | undefined
  readonly #hasher = createArtifactHasher()
  #size = 0

  constructor(expectedSize: number, signal?: AbortSignal) {
    super()
    this.#expectedSize = expectedSize
    this.#signal = signal
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      throwIfAborted(this.#signal)
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      this.#size = checkedAdd('artifact_size_bytes', this.#size, bytes.byteLength)
      if (this.#size > this.#expectedSize) {
        throw new IntegrityError('Downloaded V2 artifact exceeds its declared size', {
          reason: 'artifact_size_mismatch',
        })
      }
      this.#hasher.update(bytes)
      callback()
    } catch (error) {
      callback(asError(error))
    }
  }

  result(): Readonly<V2ArtifactFileDigest> {
    if (!this.writableFinished) {
      throw new IntegrityError('V2 artifact download did not finish', {
        reason: 'artifact_download_incomplete',
      })
    }
    return Object.freeze({
      artifactDigest: this.#hasher.digestHex(),
      artifactSizeBytes: this.#size,
    })
  }
}

class ArtifactFileSink extends Writable {
  readonly #handle: FileHandle
  readonly #expectedSize: number
  readonly #signal: AbortSignal | undefined
  readonly #hasher = createArtifactHasher()
  #offset = 0

  constructor(handle: FileHandle, expectedSize: number, signal?: AbortSignal) {
    super()
    this.#handle = handle
    this.#expectedSize = expectedSize
    this.#signal = signal
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let bytes: Buffer
    try {
      throwIfAborted(this.#signal)
      bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      const nextOffset = checkedAdd('artifact_size_bytes', this.#offset, bytes.byteLength)
      if (nextOffset > this.#expectedSize) {
        throw new IntegrityError('Downloaded V2 artifact exceeds its declared size', {
          reason: 'artifact_size_mismatch',
        })
      }
      this.#hasher.update(bytes)
    } catch (error) {
      callback(asError(error))
      return
    }
    writeAll(this.#handle, bytes, this.#offset)
      .then(() => {
        this.#offset += bytes.byteLength
        callback()
      })
      .catch((error: unknown) => callback(asError(error)))
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#handle.sync().then(() => callback(), callback)
  }

  result(): Readonly<V2ArtifactFileDigest> {
    if (!this.writableFinished) {
      throw new IntegrityError('V2 artifact file download did not finish', {
        reason: 'artifact_download_incomplete',
      })
    }
    return Object.freeze({
      artifactDigest: this.#hasher.digestHex(),
      artifactSizeBytes: this.#offset,
    })
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer, initialOffset: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      initialOffset + offset,
    )
    if (result.bytesWritten === 0) throw new Error('Unable to write V2 artifact download')
    offset += result.bytesWritten
  }
}

function estimatePrepareReservation(dataset: V2Dataset): number {
  const rowOverhead = checkedMultiply(
    'prepare_reservation_bytes',
    dataset.identity.num_records,
    V2_PREPARE_PER_RECORD_OVERHEAD_BYTES,
  )
  return checkedAdd(
    'prepare_reservation_bytes',
    checkedAdd('prepare_reservation_bytes', dataset.canonicalBytes, rowOverhead),
    V2_PREPARE_FIXED_OVERHEAD_BYTES,
  )
}

async function assertLocalArtifact(
  prepared: PreparedArtifactV2Impl,
  internal: PreparedArtifactV2Internal,
  signal?: AbortSignal,
): Promise<void> {
  const digest = await hashV2ArtifactFileHandle(internal.file.handle, signal)
  assertArtifactIdentity(digest, prepared.identity)
  const [handleStats, pathStats] = await Promise.all([
    internal.file.handle.stat({ bigint: true }),
    lstat(internal.file.path, { bigint: true }),
  ])
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    handleStats.dev !== pathStats.dev ||
    handleStats.ino !== pathStats.ino
  ) {
    throw new IntegrityError('Prepared V2 artifact path no longer references its original file', {
      reason: 'artifact_file_replaced',
    })
  }
}

function assertArtifactIdentity(
  actual: Readonly<V2ArtifactFileDigest>,
  expected: Readonly<DatasetLayoutIdentityV2>,
): void {
  if (
    actual.artifactSizeBytes !== expected.artifact_size_bytes ||
    actual.artifactDigest !== expected.artifact_digest
  ) {
    throw new IntegrityError('V2 artifact bytes do not match the declared layout identity', {
      reason: 'artifact_digest_mismatch',
      expected_digest: expected.artifact_digest,
      actual_digest: actual.artifactDigest,
      expected_size: expected.artifact_size_bytes,
      actual_size: actual.artifactSizeBytes,
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

function snapshotDatasetLimits(input: V2DatasetLimits): Readonly<V2DatasetLimits> {
  return Object.freeze({
    max_records: nonNegativeSafeInteger('max_records', input.max_records),
    max_canonical_bytes: nonNegativeSafeInteger('max_canonical_bytes', input.max_canonical_bytes),
    max_record_bytes: nonNegativeSafeInteger('max_record_bytes', input.max_record_bytes),
  })
}

function checkedAdd(name: string, left: number, right: number): number {
  nonNegativeSafeInteger(name, left)
  nonNegativeSafeInteger(name, right)
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new CapacityExceededError(`${name} exceeds the safe integer range`)
  }
  return left + right
}

function checkedMultiply(name: string, left: number, right: number): number {
  nonNegativeSafeInteger(name, left)
  nonNegativeSafeInteger(name, right)
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new CapacityExceededError(`${name} exceeds the safe integer range`)
  }
  return left * right
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Unknown V2 Store stream failure', { cause: error })
}

function operationContext(signal: AbortSignal | undefined): V2OperationContext {
  return signal === undefined ? {} : { signal }
}
