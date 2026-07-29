import type { FileHandle } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createArtifactHasher } from '@databench/hashing'
import { IntegrityError, NotFoundError, ResourceLimitError } from '@databench/schema'
import type { ConditionalCreateResult, V2OperationContext } from './contracts.js'
import { ObjectStoreFailureErrorV2 } from './contracts.js'
import {
  EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
  type EvaluationArchiveRefV1,
  EvaluationStagingStoreV1,
  evaluationArchiveObjectKeyV1,
  evaluationArchiveStagingKeyV1,
} from './evaluation-staging.js'
import { throwIfAborted } from './runtime.js'
import type { V2TempFile, V2TempStore } from './temp-store.js'
import type { WorkerStagingObjectStoreV1 } from './worker-staging.js'

const DIGEST = /^[0-9a-f]{64}$/

export interface EvaluationArtifactStoreConfigV1 {
  readonly objectStore: WorkerStagingObjectStoreV1
  readonly tempStore: V2TempStore
  readonly maxBytes?: number
  readonly signedUrlTtlMs?: number
  readonly now?: () => Date
}

export interface EvaluationArtifactDescriptorV1 {
  readonly key: string
  readonly digest: string
  readonly size: number
}

export interface FinalizeEvaluationArtifactInputV1 extends EvaluationArchiveRefV1 {
  readonly expectedDigest: string
  readonly expectedSize: number
  readonly signal?: AbortSignal
}

export class EvaluationArtifactStoreV1 {
  readonly staging: EvaluationStagingStoreV1
  readonly #objectStore: WorkerStagingObjectStoreV1
  readonly #temp: V2TempStore

  constructor(config: EvaluationArtifactStoreConfigV1) {
    this.#objectStore = config.objectStore
    this.#temp = config.tempStore
    this.staging = new EvaluationStagingStoreV1({
      objectStore: config.objectStore,
      ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
      ...(config.signedUrlTtlMs === undefined ? {} : { signedUrlTtlMs: config.signedUrlTtlMs }),
      ...(config.now === undefined ? {} : { now: config.now }),
    })
  }

  async finalize(
    input: FinalizeEvaluationArtifactInputV1,
  ): Promise<Readonly<EvaluationArtifactDescriptorV1>> {
    validateExpected(input, this.staging.maxBytes)
    const context = input.signal === undefined ? {} : { signal: input.signal }
    const materialized = await this.#readVerifiedStaging(input)
    const key = evaluationArchiveObjectKeyV1(input.expectedDigest)
    try {
      const create = (): Promise<ConditionalCreateResult> =>
        this.#objectStore.conditionalCreate({
          key,
          contentType: EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
          contentLength: materialized.size,
          body: () => materialized.file.handle.createReadStream({ autoClose: false, start: 0 }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      const result = await create()
      if (result.status === 'failure') {
        throw new ObjectStoreFailureErrorV2(
          'Unable to create immutable evaluation result archive',
          result.error,
        )
      }
      if (result.status === 'ambiguous' || result.status === 'already_exists') {
        try {
          await this.#verifyFinalObject(key, input.expectedSize, input.expectedDigest, context)
        } catch (error) {
          if (result.status === 'ambiguous') {
            throw new ObjectStoreFailureErrorV2(
              'Evaluation archive conditional create had an ambiguous outcome',
              result.error,
            )
          }
          throw error
        }
      }
      return Object.freeze({ key, digest: input.expectedDigest, size: input.expectedSize })
    } finally {
      await this.#temp.remove(materialized.file).catch(() => undefined)
      materialized.reservation.release()
    }
  }

  async #readVerifiedStaging(input: FinalizeEvaluationArtifactInputV1) {
    throwIfAborted(input.signal)
    const key = evaluationArchiveStagingKeyV1(input)
    const context = input.signal === undefined ? {} : { signal: input.signal }
    const head = await this.#objectStore.headStaging(key, context)
    if (head === null) throw new NotFoundError('Evaluation archive staging object was not found')
    if (head.contentType !== EVALUATION_ARCHIVE_MEDIA_TYPE_V1) {
      throw new IntegrityError('Evaluation archive staging content type is invalid')
    }
    if (head.size !== input.expectedSize) {
      throw new IntegrityError('Evaluation archive staging size does not match finalize request', {
        expected: input.expectedSize,
        actual: head.size,
      })
    }
    const reservation = await this.#temp.reserve(head.size, input.signal)
    let file: V2TempFile | undefined
    try {
      file = await this.#temp.create('evaluation-archive', input.signal)
      const sink = new FileDigestSink(file.handle, this.staging.maxBytes, input.signal)
      const status = await this.#objectStore.download({
        key,
        destination: sink,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (status === 'not_found')
        throw new NotFoundError('Evaluation archive staging object disappeared')
      const actual = sink.result()
      if (actual.size !== head.size || actual.digest !== input.expectedDigest) {
        throw new IntegrityError('Evaluation archive staging digest or size is invalid', {
          expected_digest: input.expectedDigest,
          actual_digest: actual.digest,
          expected_size: head.size,
          actual_size: actual.size,
        })
      }
      return { file, reservation, ...actual }
    } catch (error) {
      if (file) await this.#temp.remove(file).catch(() => undefined)
      reservation.release()
      throw error
    }
  }

  async #verifyFinalObject(
    key: string,
    expectedSize: number,
    expectedDigest: string,
    context: V2OperationContext,
  ): Promise<void> {
    const head = await this.#objectStore.head(key, context)
    if (head === null) throw new NotFoundError('Immutable evaluation archive was not found')
    if (head.size !== expectedSize) {
      throw new IntegrityError('Immutable evaluation archive size is inconsistent')
    }
    const sink = new DigestSink(this.staging.maxBytes, context.signal)
    const status = await this.#objectStore.download({
      key,
      destination: sink,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    if (status === 'not_found') throw new NotFoundError('Immutable evaluation archive disappeared')
    const actual = sink.result()
    if (actual.size !== expectedSize || actual.digest !== expectedDigest) {
      throw new IntegrityError('Immutable evaluation archive content is inconsistent')
    }
  }
}

class DigestSink extends Writable {
  readonly #hasher = createArtifactHasher()
  readonly #limit: number
  readonly #signal: AbortSignal | undefined
  #size = 0

  constructor(limit: number, signal?: AbortSignal) {
    super()
    this.#limit = limit
    this.#signal = signal
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      throwIfAborted(this.#signal)
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
      if (bytes.byteLength > this.#limit - this.#size) {
        throw new ResourceLimitError('Evaluation archive exceeds its configured byte limit', {
          resource: 'evaluation_archive_bytes',
          limit: this.#limit,
          actual: this.#size + bytes.byteLength,
        })
      }
      this.#hasher.update(bytes)
      this.#size += bytes.byteLength
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Evaluation archive digest failed'))
    }
  }

  result(): { readonly size: number; readonly digest: string } {
    if (!this.writableFinished) throw new IntegrityError('Evaluation archive download ended early')
    return { size: this.#size, digest: this.#hasher.digestHex() }
  }
}

class FileDigestSink extends DigestSink {
  readonly #file: FileHandle
  #offset = 0

  constructor(file: FileHandle, limit: number, signal?: AbortSignal) {
    super(limit, signal)
    this.#file = file
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    writeAll(this.#file, bytes, this.#offset).then(
      () => {
        this.#offset += bytes.byteLength
        super._write(bytes, encoding, callback)
      },
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error('Archive write failed')),
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#file.sync().then(() => callback(), callback)
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array, offset: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, offset + written)
    if (result.bytesWritten <= 0)
      throw new IntegrityError('Evaluation archive temp write ended early')
    written += result.bytesWritten
  }
}

function validateExpected(input: FinalizeEvaluationArtifactInputV1, maxBytes: number): void {
  evaluationArchiveStagingKeyV1(input)
  if (!DIGEST.test(input.expectedDigest)) {
    throw new TypeError(
      'Evaluation archive expected digest must be 64 lowercase hexadecimal characters',
    )
  }
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0) {
    throw new TypeError('Evaluation archive expected size must be a positive safe integer')
  }
  if (input.expectedSize > maxBytes) {
    throw new ResourceLimitError('Evaluation archive exceeds its configured byte limit', {
      resource: 'evaluation_archive_bytes',
      limit: maxBytes,
      actual: input.expectedSize,
    })
  }
}
