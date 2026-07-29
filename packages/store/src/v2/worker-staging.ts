import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { ConflictError, IntegrityError, NotFoundError, ResourceLimitError } from '@databench/schema'
import type {
  ConditionalCreateResult,
  ConditionalObjectStoreV2,
  V2OperationContext,
} from './contracts.js'
import { ObjectStoreFailureErrorV2 } from './contracts.js'
import { throwIfAborted } from './runtime.js'
import { type V2TempFile, V2TempStore } from './temp-store.js'
import { type WorkerStagingObjectRefV1, workerStagingKeyV1 } from './worker-staging-keys.js'

export const WORKER_STAGING_JSONL_MEDIA_TYPE = 'application/x-ndjson'
export const DEFAULT_WORKER_STAGING_MAX_BYTES = 1024 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/

export interface WorkerStagingHeadV1 {
  readonly size: number
  readonly contentType: string
}

export interface WorkerStagingPresignInputV1 {
  readonly key: string
  readonly method: 'GET' | 'PUT'
  readonly contentType: string
  readonly expiresInSeconds: number
  readonly ifNoneMatch?: '*'
}

export interface WorkerStagingObjectStoreV1 extends ConditionalObjectStoreV2 {
  headStaging(
    key: string,
    context?: V2OperationContext,
  ): Promise<Readonly<WorkerStagingHeadV1> | null>
  presignStaging(input: WorkerStagingPresignInputV1): Promise<string>
  deleteStaging(key: string, context?: V2OperationContext): Promise<void>
}

export interface WorkerStagingStoreConfigV1 {
  readonly objectStore: WorkerStagingObjectStoreV1
  readonly tempRoot: string
  readonly maxBytes?: number
  readonly signedUrlTtlMs: number
}

export interface WorkerStagingDescriptorV1 {
  readonly key: string
  readonly mediaType: typeof WORKER_STAGING_JSONL_MEDIA_TYPE
  readonly size: number
  readonly digest: string
}

export interface WorkerStagingSignedSourceV1 extends WorkerStagingDescriptorV1 {
  readonly readUrl: string
}

export interface WorkerStagingSignedTargetV1 {
  readonly key: string
  readonly mediaType: typeof WORKER_STAGING_JSONL_MEDIA_TYPE
  readonly maxSize: number
  readonly writeUrl: string
}

export interface WorkerStagingReadOptionsV1 {
  readonly maxBytes?: number
  readonly expectedSize?: number
  readonly expectedDigest?: string
  readonly signal?: AbortSignal
}

export class WorkerStagingStoreV1 {
  readonly #objectStore: WorkerStagingObjectStoreV1
  readonly #temp: V2TempStore
  readonly #maxBytes: number
  readonly #expiresInSeconds: number

  constructor(config: WorkerStagingStoreConfigV1) {
    this.#objectStore = config.objectStore
    this.#maxBytes = positiveSafeInteger(
      'Worker staging maxBytes',
      config.maxBytes ?? DEFAULT_WORKER_STAGING_MAX_BYTES,
    )
    const ttlMs = positiveSafeInteger('Worker staging signedUrlTtlMs', config.signedUrlTtlMs)
    this.#expiresInSeconds = Math.ceil(ttlMs / 1_000)
    this.#temp = new V2TempStore({ tempRoot: config.tempRoot })
  }

  async createInput(
    ref: Omit<WorkerStagingObjectRefV1, 'logicalName'>,
    source: AsyncIterable<Uint8Array>,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingDescriptorV1>> {
    const objectRef = { ...ref, logicalName: 'input' as const }
    const key = workerStagingKeyV1(objectRef)
    const materialized = await this.#materialize(source, this.#maxBytes, context.signal)
    try {
      const create = (): Promise<ConditionalCreateResult> =>
        this.#objectStore.conditionalCreate({
          key,
          contentType: WORKER_STAGING_JSONL_MEDIA_TYPE,
          contentLength: materialized.size,
          body: () => materialized.handle.createReadStream({ autoClose: false, start: 0 }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
      const result = await create()
      if (result.status === 'failure') {
        throw new ObjectStoreFailureErrorV2('Unable to create Worker staging input', result.error)
      }
      if (result.status === 'ambiguous' || result.status === 'already_exists') {
        await this.#assertRemoteDescriptor(
          objectRef,
          {
            size: materialized.size,
            digest: materialized.digest,
          },
          context.signal,
        )
      }
      return Object.freeze({
        key,
        mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
        size: materialized.size,
        digest: materialized.digest,
      })
    } finally {
      await materialized.cleanup()
    }
  }

  async signRead(
    ref: Omit<WorkerStagingObjectRefV1, 'logicalName'>,
    descriptor: WorkerStagingDescriptorV1,
  ): Promise<Readonly<WorkerStagingSignedSourceV1>> {
    const key = workerStagingKeyV1({ ...ref, logicalName: 'input' })
    if (descriptor.key !== key) throw new TypeError('Worker staging input descriptor key mismatch')
    validateDescriptor(descriptor)
    const readUrl = await this.#objectStore.presignStaging({
      key,
      method: 'GET',
      contentType: WORKER_STAGING_JSONL_MEDIA_TYPE,
      expiresInSeconds: this.#expiresInSeconds,
    })
    return Object.freeze({ ...descriptor, readUrl })
  }

  async createOutputTarget(
    ref: Omit<WorkerStagingObjectRefV1, 'logicalName'>,
    maxSize = this.#maxBytes,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingSignedTargetV1>> {
    const key = workerStagingKeyV1({ ...ref, logicalName: 'output' })
    const boundedMaxSize = positiveSafeInteger('Worker staging output maxSize', maxSize)
    if (boundedMaxSize > this.#maxBytes) {
      throw new ResourceLimitError('Worker staging output limit exceeds the configured maximum', {
        resource: 'worker_staging_bytes',
        limit: this.#maxBytes,
        actual: boundedMaxSize,
      })
    }
    if ((await this.#objectStore.headStaging(key, context)) !== null) {
      throw new ConflictError('Worker staging output already exists', { key })
    }
    const writeUrl = await this.#objectStore.presignStaging({
      key,
      method: 'PUT',
      contentType: WORKER_STAGING_JSONL_MEDIA_TYPE,
      expiresInSeconds: this.#expiresInSeconds,
    })
    return Object.freeze({
      key,
      mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
      maxSize: boundedMaxSize,
      writeUrl,
    })
  }

  async statExact(
    ref: WorkerStagingObjectRefV1,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingHeadV1> | null> {
    const key = workerStagingKeyV1(ref)
    const head = await this.#objectStore.headStaging(key, context)
    if (!head) return null
    validateRemoteHead(head, this.#maxBytes)
    return Object.freeze({ ...head })
  }

  async *readExact(
    ref: WorkerStagingObjectRefV1,
    options: WorkerStagingReadOptionsV1 = {},
  ): AsyncIterableIterator<Uint8Array> {
    const key = workerStagingKeyV1(ref)
    const limit = options.maxBytes ?? this.#maxBytes
    positiveSafeInteger('Worker staging read maxBytes', limit)
    if (limit > this.#maxBytes) {
      throw new ResourceLimitError('Worker staging read limit exceeds the configured maximum', {
        resource: 'worker_staging_bytes',
        limit: this.#maxBytes,
        actual: limit,
      })
    }
    if (options.expectedSize !== undefined)
      nonNegativeSafeInteger('expectedSize', options.expectedSize)
    if (options.expectedDigest !== undefined && !SHA256.test(options.expectedDigest)) {
      throw new TypeError('Worker staging expected digest must be 64 lowercase hex characters')
    }
    const head = await this.#objectStore.headStaging(key, operationContext(options.signal))
    if (!head) throw new NotFoundError('Worker staging object does not exist', { key })
    validateRemoteHead(head, limit)
    if (options.expectedSize !== undefined && head.size !== options.expectedSize) {
      throw new IntegrityError('Worker staging object size does not match Worker terminal', {
        expected: options.expectedSize,
        actual: head.size,
      })
    }
    const reservation = await this.#temp.reserve(head.size, options.signal)
    let file: V2TempFile | undefined
    try {
      file = await this.#temp.create('worker-output', options.signal)
      const sink = new StagingFileSink(file.handle, limit, options.signal)
      const status = await this.#objectStore.download({
        key,
        destination: sink,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (status === 'not_found')
        throw new NotFoundError('Worker staging object disappeared', { key })
      const actual = sink.result()
      if (actual.size !== head.size) {
        throw new IntegrityError('Worker staging object changed while it was read', {
          expected: head.size,
          actual: actual.size,
        })
      }
      if (options.expectedDigest !== undefined && actual.digest !== options.expectedDigest) {
        throw new IntegrityError('Worker staging object digest does not match Worker terminal', {
          expected: options.expectedDigest,
          actual: actual.digest,
        })
      }
      let offset = 0
      const buffer = Buffer.allocUnsafe(64 * 1024)
      while (offset < actual.size) {
        throwIfAborted(options.signal)
        const result = await file.handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, actual.size - offset),
          offset,
        )
        if (result.bytesRead <= 0) throw new IntegrityError('Worker staging temp file ended early')
        offset += result.bytesRead
        yield buffer.subarray(0, result.bytesRead).slice()
      }
    } finally {
      if (file) await this.#temp.remove(file)
      reservation.release()
    }
  }

  async deleteExact(
    ref: WorkerStagingObjectRefV1,
    context: V2OperationContext = {},
  ): Promise<void> {
    await this.#objectStore.deleteStaging(workerStagingKeyV1(ref), context)
  }

  async #assertRemoteDescriptor(
    ref: WorkerStagingObjectRefV1,
    expected: { readonly size: number; readonly digest: string },
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const _chunk of this.readExact(ref, {
      expectedSize: expected.size,
      expectedDigest: expected.digest,
      ...(signal === undefined ? {} : { signal }),
    })) {
      // The bounded reader performs the complete size/digest verification.
    }
  }

  async #materialize(source: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal) {
    const reservation = await this.#temp.reserve(limit, signal)
    let file: V2TempFile | undefined
    const hasher = createHash('sha256')
    let size = 0
    try {
      file = await this.#temp.create('worker-input', signal)
      for await (const chunk of source) {
        throwIfAborted(signal)
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Worker staging source must yield Uint8Array chunks')
        }
        if (chunk.byteLength > limit - size) {
          throw new ResourceLimitError('Worker staging input exceeds its byte limit', {
            resource: 'worker_staging_bytes',
            limit,
            actual: size + chunk.byteLength,
          })
        }
        await writeAll(file.handle, chunk, size)
        size += chunk.byteLength
        hasher.update(chunk)
      }
      await file.handle.sync()
      let cleaned = false
      return {
        handle: file.handle,
        size,
        digest: hasher.digest('hex'),
        cleanup: async () => {
          if (cleaned) return
          cleaned = true
          if (file) await this.#temp.remove(file)
          reservation.release()
        },
      }
    } catch (error) {
      if (file) await this.#temp.remove(file).catch(() => undefined)
      reservation.release()
      throw error
    }
  }
}

function validateDescriptor(value: WorkerStagingDescriptorV1): void {
  if (value.mediaType !== WORKER_STAGING_JSONL_MEDIA_TYPE) {
    throw new TypeError('Worker staging descriptor media type is invalid')
  }
  nonNegativeSafeInteger('Worker staging descriptor size', value.size)
  if (!SHA256.test(value.digest)) {
    throw new TypeError('Worker staging descriptor digest must be SHA-256 lowercase hex')
  }
}

function validateRemoteHead(value: WorkerStagingHeadV1, limit: number): void {
  nonNegativeSafeInteger('Worker staging remote size', value.size)
  if (value.size > limit) {
    throw new ResourceLimitError('Worker staging object exceeds its byte limit', {
      resource: 'worker_staging_bytes',
      limit,
      actual: value.size,
    })
  }
  if (normalizeMediaType(value.contentType) !== WORKER_STAGING_JSONL_MEDIA_TYPE) {
    throw new IntegrityError('Worker staging object has an unexpected media type', {
      expected: WORKER_STAGING_JSONL_MEDIA_TYPE,
      actual: value.contentType,
    })
  }
}

class StagingFileSink extends Writable {
  readonly #handle: FileHandle
  readonly #limit: number
  readonly #signal: AbortSignal | undefined
  readonly #hasher = createHash('sha256')
  #size = 0

  constructor(handle: FileHandle, limit: number, signal?: AbortSignal) {
    super()
    this.#handle = handle
    this.#limit = limit
    this.#signal = signal
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
    void this.#append(bytes).then(() => callback(), callback)
  }

  result(): { readonly size: number; readonly digest: string } {
    return { size: this.#size, digest: this.#hasher.digest('hex') }
  }

  async #append(bytes: Uint8Array): Promise<void> {
    throwIfAborted(this.#signal)
    if (bytes.byteLength > this.#limit - this.#size) {
      throw new ResourceLimitError('Worker staging object exceeds its byte limit', {
        resource: 'worker_staging_bytes',
        limit: this.#limit,
        actual: this.#size + bytes.byteLength,
      })
    }
    await writeAll(this.#handle, bytes, this.#size)
    this.#size += bytes.byteLength
    this.#hasher.update(bytes)
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (result.bytesWritten <= 0) throw new IntegrityError('Worker staging temp file write stalled')
    offset += result.bytesWritten
  }
}

function normalizeMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function positiveSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be positive`)
  return value
}

function nonNegativeSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be non-negative`)
  return value
}

function operationContext(signal: AbortSignal | undefined): V2OperationContext {
  return signal === undefined ? {} : { signal }
}

export function isWorkerStagingObjectStoreV1(
  value: ConditionalObjectStoreV2,
): value is WorkerStagingObjectStoreV1 {
  const candidate = value as unknown as Record<string, unknown>
  return (
    typeof candidate.headStaging === 'function' &&
    typeof candidate.presignStaging === 'function' &&
    typeof candidate.deleteStaging === 'function'
  )
}
