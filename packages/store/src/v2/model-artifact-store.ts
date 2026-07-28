import type { FileHandle } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { createArtifactHasher } from '@databench/hashing'
import { ConflictError, IntegrityError, NotFoundError, ResourceLimitError } from '@databench/schema'
import type { ConditionalCreateResult, V2OperationContext } from './contracts.js'
import { ObjectStoreFailureErrorV2 } from './contracts.js'
import { modelArtifactObjectKeyV1, modelArtifactStagingKeyV1 } from './model-artifact-keys.js'
import { throwIfAborted } from './runtime.js'
import type { V2TempFile, V2TempStore } from './temp-store.js'
import type { WorkerStagingObjectStoreV1 } from './worker-staging.js'

export const MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE = 'application/zstd'
export const DEFAULT_MODEL_ARTIFACT_MAX_BYTES_V1 = 16 * 1024 * 1024 * 1024
const DIGEST = /^[0-9a-f]{64}$/u

export interface ModelArtifactStoreConfigV1 {
  readonly objectStore: WorkerStagingObjectStoreV1
  readonly tempStore: V2TempStore
  readonly signedUrlTtlMs: number
  readonly maxBytes?: number
}

export interface ModelArtifactStagingTargetV1 {
  readonly key: string
  readonly mediaType: typeof MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE
  readonly maxSizeBytes: number
  readonly writeUrl: string
  readonly expiresAt: string
}

export interface ModelArtifactArchiveIdentityV1 {
  readonly archiveDigest: string
  readonly archiveSizeBytes: number
}

export interface ModelArtifactPublicationV1 extends ModelArtifactArchiveIdentityV1 {
  readonly objectKey: string
  readonly created: boolean
}

export class ModelArtifactStoreV1 {
  readonly #objectStore: WorkerStagingObjectStoreV1
  readonly #tempStore: V2TempStore
  readonly #maxBytes: number
  readonly #expiresInSeconds: number

  constructor(config: ModelArtifactStoreConfigV1) {
    this.#objectStore = config.objectStore
    this.#tempStore = config.tempStore
    this.#maxBytes = positiveSafeInteger(
      'Model Artifact max bytes',
      config.maxBytes ?? DEFAULT_MODEL_ARTIFACT_MAX_BYTES_V1,
    )
    this.#expiresInSeconds = Math.ceil(
      positiveSafeInteger('Model Artifact signed URL TTL', config.signedUrlTtlMs) / 1_000,
    )
  }

  async createStagingTarget(
    importId: string,
    maxSizeBytes = this.#maxBytes,
    context: V2OperationContext = {},
  ): Promise<Readonly<ModelArtifactStagingTargetV1>> {
    const key = modelArtifactStagingKeyV1(importId)
    const limit = positiveSafeInteger('Model Artifact staging max bytes', maxSizeBytes)
    if (limit > this.#maxBytes) {
      throw new ResourceLimitError('Model Artifact staging limit exceeds its configured maximum', {
        resource: 'model_artifact_bytes',
        limit: this.#maxBytes,
        actual: limit,
      })
    }
    if ((await this.#objectStore.headStaging(key, context)) !== null) {
      throw new ConflictError('Model Artifact staging object already exists', {
        import_id: importId,
      })
    }
    const writeUrl = await this.#objectStore.presignStaging({
      key,
      method: 'PUT',
      contentType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
      expiresInSeconds: this.#expiresInSeconds,
    })
    return Object.freeze({
      key,
      mediaType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
      maxSizeBytes: limit,
      writeUrl,
      expiresAt: new Date(Date.now() + this.#expiresInSeconds * 1_000).toISOString(),
    })
  }

  async finalizeStaging(
    importId: string,
    expectedInput: ModelArtifactArchiveIdentityV1,
    context: V2OperationContext = {},
  ): Promise<Readonly<ModelArtifactPublicationV1>> {
    const expected = validateIdentity(expectedInput, this.#maxBytes)
    const stagingKey = modelArtifactStagingKeyV1(importId)
    const head = await this.#objectStore.headStaging(stagingKey, context)
    if (head === null) {
      throw new NotFoundError('Model Artifact staging object does not exist', {
        import_id: importId,
      })
    }
    if (normalizeMediaType(head.contentType) !== MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE) {
      throw new IntegrityError('Model Artifact staging object has an unexpected media type', {
        expected: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        actual: head.contentType,
      })
    }
    if (head.size !== expected.archiveSizeBytes) {
      throw new IntegrityError('Model Artifact staging size does not match Provider terminal', {
        expected: expected.archiveSizeBytes,
        actual: head.size,
      })
    }
    const materialized = await this.#downloadToTemp(stagingKey, expected, context.signal)
    try {
      const objectKey = modelArtifactObjectKeyV1(expected.archiveDigest)
      let consumedBytes = 0
      const create = await this.#objectStore.conditionalCreate({
        key: objectKey,
        contentType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        contentLength: expected.archiveSizeBytes,
        body: () =>
          Readable.from(
            readFileChunks(
              materialized.file.handle,
              expected.archiveSizeBytes,
              context.signal,
              (n) => {
                consumedBytes += n
              },
            ),
          ),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      if (create.status === 'failure') {
        throw new ObjectStoreFailureErrorV2('Unable to publish Model Artifact', create.error)
      }
      if (create.status === 'created' && consumedBytes !== expected.archiveSizeBytes) {
        throw new IntegrityError('Model Artifact upload body was not consumed completely', {
          expected: expected.archiveSizeBytes,
          actual: consumedBytes,
        })
      }
      if (create.status === 'already_exists' || create.status === 'ambiguous') {
        await this.#assertPublished(objectKey, expected, context.signal, create)
      }
      return Object.freeze({
        ...expected,
        objectKey,
        created: create.status === 'created',
      })
    } finally {
      await materialized.cleanup()
    }
  }

  async *read(
    identityInput: ModelArtifactArchiveIdentityV1,
    context: V2OperationContext = {},
  ): AsyncIterableIterator<Uint8Array> {
    const identity = validateIdentity(identityInput, this.#maxBytes)
    const objectKey = modelArtifactObjectKeyV1(identity.archiveDigest)
    const head = await this.#objectStore.head(objectKey, context)
    if (head === null) throw new NotFoundError('Model Artifact object does not exist')
    if (head.size !== identity.archiveSizeBytes) {
      throw new IntegrityError('Model Artifact object size does not match Catalog', {
        expected: identity.archiveSizeBytes,
        actual: head.size,
      })
    }
    const materialized = await this.#downloadToTemp(objectKey, identity, context.signal)
    try {
      yield* readFileChunks(materialized.file.handle, identity.archiveSizeBytes, context.signal)
    } finally {
      await materialized.cleanup()
    }
  }

  async cleanupStaging(importId: string, context: V2OperationContext = {}): Promise<void> {
    await this.#objectStore.deleteStaging(modelArtifactStagingKeyV1(importId), context)
  }

  async #downloadToTemp(
    key: string,
    expected: Readonly<ModelArtifactArchiveIdentityV1>,
    signal?: AbortSignal,
  ): Promise<{ readonly file: V2TempFile; readonly cleanup: () => Promise<void> }> {
    const reservation = await this.#tempStore.reserve(expected.archiveSizeBytes, signal)
    let file: V2TempFile | undefined
    try {
      file = await this.#tempStore.create('model-artifact', signal)
      const sink = new ModelArtifactFileSink(file.handle, this.#maxBytes, signal)
      const status = await this.#objectStore.download({
        key,
        destination: sink,
        ...(signal === undefined ? {} : { signal }),
      })
      if (status === 'not_found') throw new NotFoundError('Model Artifact object disappeared')
      const actual = sink.result()
      if (
        actual.archiveSizeBytes !== expected.archiveSizeBytes ||
        actual.archiveDigest !== expected.archiveDigest
      ) {
        throw new IntegrityError('Model Artifact bytes do not match their declared identity', {
          expected_digest: expected.archiveDigest,
          actual_digest: actual.archiveDigest,
          expected_size: expected.archiveSizeBytes,
          actual_size: actual.archiveSizeBytes,
        })
      }
      await file.handle.sync()
      let cleaned = false
      return Object.freeze({
        file,
        cleanup: async () => {
          if (cleaned) return
          cleaned = true
          if (file) await this.#tempStore.remove(file)
          reservation.release()
        },
      })
    } catch (error) {
      if (file) await this.#tempStore.remove(file).catch(() => undefined)
      reservation.release()
      throw error
    }
  }

  async #assertPublished(
    objectKey: string,
    expected: Readonly<ModelArtifactArchiveIdentityV1>,
    signal: AbortSignal | undefined,
    create: Exclude<ConditionalCreateResult, { readonly status: 'created' | 'failure' }>,
  ): Promise<void> {
    const head = await this.#objectStore.head(objectKey, operationContext(signal))
    if (head === null) {
      const cause = create.status === 'ambiguous' ? create.error : undefined
      throw new ObjectStoreFailureErrorV2(
        'Model Artifact publication could not be confirmed',
        cause,
      )
    }
    if (head.size !== expected.archiveSizeBytes) {
      throw new IntegrityError('Existing Model Artifact has an unexpected size', {
        expected: expected.archiveSizeBytes,
        actual: head.size,
      })
    }
    const sink = new ModelArtifactHashSink(this.#maxBytes, signal)
    const status = await this.#objectStore.download({
      key: objectKey,
      destination: sink,
      ...(signal === undefined ? {} : { signal }),
    })
    if (status === 'not_found') {
      throw new IntegrityError('Existing Model Artifact disappeared during verification')
    }
    const actual = sink.result()
    if (
      actual.archiveSizeBytes !== expected.archiveSizeBytes ||
      actual.archiveDigest !== expected.archiveDigest
    ) {
      throw new IntegrityError('Existing Model Artifact conflicts with immutable identity', {
        expected_digest: expected.archiveDigest,
        actual_digest: actual.archiveDigest,
      })
    }
  }
}

class ModelArtifactHashSink extends Writable {
  readonly #hasher = createArtifactHasher()
  readonly #limit: number
  readonly #signal: AbortSignal | undefined
  #size = 0
  #finished = false

  constructor(limit: number, signal?: AbortSignal) {
    super()
    this.#limit = limit
    this.#signal = signal
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      throwIfAborted(this.#signal)
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
      if (bytes.byteLength > this.#limit - this.#size) {
        throw new ResourceLimitError('Model Artifact exceeds its byte limit', {
          resource: 'model_artifact_bytes',
          limit: this.#limit,
          actual: this.#size + bytes.byteLength,
        })
      }
      this.#hasher.update(bytes)
      this.#size += bytes.byteLength
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#finished = true
    callback()
  }

  result(): Readonly<ModelArtifactArchiveIdentityV1> {
    if (!this.#finished) throw new IntegrityError('Model Artifact download did not finish')
    return Object.freeze({
      archiveDigest: this.#hasher.digestHex(),
      archiveSizeBytes: this.#size,
    })
  }
}

class ModelArtifactFileSink extends ModelArtifactHashSink {
  readonly #file: FileHandle
  #offset = 0

  constructor(file: FileHandle, limit: number, signal?: AbortSignal) {
    super(limit, signal)
    this.#file = file
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    super._write(bytes, encoding, (error) => {
      if (error) {
        callback(error)
        return
      }
      writeAll(this.#file, bytes, this.#offset)
        .then(() => {
          this.#offset += bytes.byteLength
          callback()
        })
        .catch((writeError: unknown) => {
          callback(writeError instanceof Error ? writeError : new Error(String(writeError)))
        })
    })
  }
}

async function* readFileChunks(
  file: FileHandle,
  size: number,
  signal?: AbortSignal,
  onChunk?: (size: number) => void,
): AsyncIterableIterator<Uint8Array> {
  let offset = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (offset < size) {
    throwIfAborted(signal)
    const result = await file.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset)
    if (result.bytesRead <= 0) throw new IntegrityError('Model Artifact temp file ended early')
    offset += result.bytesRead
    onChunk?.(result.bytesRead)
    yield buffer.subarray(0, result.bytesRead).slice()
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array, offset: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, offset + written)
    if (result.bytesWritten <= 0) throw new Error('Unable to write Model Artifact temp file')
    written += result.bytesWritten
  }
}

function validateIdentity(
  input: ModelArtifactArchiveIdentityV1,
  limit: number,
): Readonly<ModelArtifactArchiveIdentityV1> {
  if (!DIGEST.test(input.archiveDigest)) {
    throw new TypeError('Model Artifact archive digest must be 64 lowercase hexadecimal characters')
  }
  const archiveSizeBytes = positiveSafeInteger(
    'Model Artifact archive size',
    input.archiveSizeBytes,
  )
  if (archiveSizeBytes > limit) {
    throw new ResourceLimitError('Model Artifact archive exceeds its byte limit', {
      resource: 'model_artifact_bytes',
      limit,
      actual: archiveSizeBytes,
    })
  }
  return Object.freeze({ archiveDigest: input.archiveDigest, archiveSizeBytes })
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizeMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function operationContext(signal?: AbortSignal): V2OperationContext {
  return signal === undefined ? {} : { signal }
}
