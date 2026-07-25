import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { DomainError } from '@databench/schema'
import type {
  ConditionalCreateInput,
  ConditionalCreateResult,
  ConditionalObjectStoreV2,
  ObjectDownloadInputV2,
  ObjectHeadV2,
  V2OperationContext,
} from './contracts.js'
import { ObjectStoreFailureErrorV2 } from './contracts.js'
import { abortError, throwIfAborted } from './runtime.js'
import type {
  WorkerStagingHeadV1,
  WorkerStagingObjectStoreV1,
  WorkerStagingPresignInputV1,
} from './worker-staging.js'

export const DEFAULT_V2_PROVIDER_REQUEST_TIMEOUT_MS = 30_000

export interface S3ConditionalObjectStoreV2Config {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly workerEndpoint?: string
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  readonly forcePathStyle?: boolean
  readonly requestTimeoutMs?: number
  readonly client?: S3Client
}

export class S3ConditionalObjectStoreV2
  implements ConditionalObjectStoreV2, WorkerStagingObjectStoreV1
{
  readonly #bucket: string
  readonly #client: S3Client
  readonly #signingClient: S3Client
  readonly #requestTimeoutMs: number

  constructor(config: S3ConditionalObjectStoreV2Config) {
    this.#bucket = requiredString('bucket', config.bucket)
    this.#requestTimeoutMs = positiveSafeInteger(
      'requestTimeoutMs',
      config.requestTimeoutMs ?? DEFAULT_V2_PROVIDER_REQUEST_TIMEOUT_MS,
    )
    this.#client = config.client ?? new S3Client(buildS3ClientConfig(config))
    this.#signingClient =
      config.workerEndpoint === undefined
        ? this.#client
        : new S3Client(buildS3ClientConfig({ ...config, endpoint: config.workerEndpoint }))
  }

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    throwIfAborted(input.signal)
    let body: Readable | undefined
    let bodyError: unknown
    const requestSignal = requestAbortSignal(input.signal, this.#requestTimeoutMs)
    try {
      body = input.body()
      body.once('error', (error) => {
        bodyError = error
      })
      await this.#client.send(
        new PutObjectCommand({
          Body: body,
          Bucket: this.#bucket,
          ContentLength: input.contentLength,
          ContentType: input.contentType,
          IfNoneMatch: '*',
          Key: input.key,
        }),
        { abortSignal: requestSignal },
      )
      return { status: 'created' }
    } catch (error) {
      if (isS3AlreadyExists(error)) return { status: 'already_exists' }
      if (input.signal?.aborted) return { status: 'ambiguous', error }
      // A deterministic caller-owned stream failure takes precedence over an
      // ambiguous wrapper error synthesized by the SDK request machinery.
      if (bodyError !== undefined && !isS3Ambiguous(bodyError, requestSignal)) {
        return { status: 'failure', error: bodyError }
      }
      if (bodyError !== undefined && isS3Ambiguous(bodyError, requestSignal)) {
        return { status: 'ambiguous', error: bodyError }
      }
      if (isS3Ambiguous(error, requestSignal)) return { status: 'ambiguous', error }
      return { status: 'failure', error }
    } finally {
      body?.destroy()
    }
  }

  async head(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<ObjectHeadV2> | null> {
    throwIfAborted(context.signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestSignal = requestAbortSignal(context.signal, this.#requestTimeoutMs)
      try {
        const output = await this.#client.send(
          new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
          { abortSignal: requestSignal },
        )
        throwIfAborted(context.signal)
        const size = output.ContentLength
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
          throw new ObjectStoreFailureErrorV2(
            'S3 returned an invalid object content length',
            undefined,
            's3',
          )
        }
        return Object.freeze({ size })
      } catch (error) {
        if (context.signal?.aborted) throw abortError(context.signal.reason)
        if (isS3HeadMissing(error)) return null
        if (error instanceof ObjectStoreFailureErrorV2) throw error
        if (attempt === 0 && isS3Ambiguous(error, requestSignal)) continue
        throw new ObjectStoreFailureErrorV2('Unable to inspect S3 object', error, 's3')
      }
    }
    throw new ObjectStoreFailureErrorV2('Unable to inspect S3 object', undefined, 's3')
  }

  async headStaging(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingHeadV1> | null> {
    throwIfAborted(context.signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestSignal = requestAbortSignal(context.signal, this.#requestTimeoutMs)
      try {
        const output = await this.#client.send(
          new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
          { abortSignal: requestSignal },
        )
        throwIfAborted(context.signal)
        const size = output.ContentLength
        if (
          typeof size !== 'number' ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          typeof output.ContentType !== 'string'
        ) {
          throw new ObjectStoreFailureErrorV2(
            'S3 returned invalid Worker staging metadata',
            undefined,
            's3',
          )
        }
        return Object.freeze({ size, contentType: output.ContentType })
      } catch (error) {
        if (context.signal?.aborted) throw abortError(context.signal.reason)
        if (isS3HeadMissing(error)) return null
        if (error instanceof ObjectStoreFailureErrorV2) throw error
        if (attempt === 0 && isS3Ambiguous(error, requestSignal)) continue
        throw new ObjectStoreFailureErrorV2('Unable to inspect S3 staging object', error, 's3')
      }
    }
    throw new ObjectStoreFailureErrorV2('Unable to inspect S3 staging object', undefined, 's3')
  }

  async presignStaging(input: WorkerStagingPresignInputV1): Promise<string> {
    const expiresIn = positiveSafeInteger('expiresInSeconds', input.expiresInSeconds)
    try {
      const command =
        input.method === 'GET'
          ? new GetObjectCommand({ Bucket: this.#bucket, Key: input.key })
          : new PutObjectCommand({
              Bucket: this.#bucket,
              ContentType: input.contentType,
              Key: input.key,
            })
      return await getSignedUrl(this.#signingClient, command, {
        expiresIn,
        ...(input.method === 'PUT' ? { signableHeaders: new Set(['content-type']) } : {}),
      })
    } catch (error) {
      throw new ObjectStoreFailureErrorV2('Unable to sign S3 staging request', error, 's3')
    }
  }

  async deleteStaging(key: string, context: V2OperationContext = {}): Promise<void> {
    throwIfAborted(context.signal)
    const requestSignal = requestAbortSignal(context.signal, this.#requestTimeoutMs)
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }), {
        abortSignal: requestSignal,
      })
      throwIfAborted(context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      throw new ObjectStoreFailureErrorV2('Unable to delete S3 staging object', error, 's3')
    }
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    throwIfAborted(input.signal)
    let destinationError: unknown
    input.destination.once('error', (error) => {
      destinationError = error
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestSignal = requestAbortSignal(input.signal, this.#requestTimeoutMs)
      let source: Readable | undefined
      try {
        const output = await this.#client.send(
          new GetObjectCommand({ Bucket: this.#bucket, Key: input.key }),
          { abortSignal: requestSignal },
        )
        if (!output.Body) {
          throw new ObjectStoreFailureErrorV2(
            'S3 returned an empty object response body',
            undefined,
            's3',
          )
        }
        source = bodyToReadable(output.Body)
        await pipeline(source, input.destination, { signal: requestSignal })
        throwIfAborted(input.signal)
        return 'downloaded'
      } catch (error) {
        if (input.signal?.aborted) throw abortError(input.signal.reason)
        if (isS3GetMissing(error)) return 'not_found'
        if (destinationError === error && !isS3Ambiguous(error, requestSignal)) {
          throw error
        }
        if (destinationError instanceof DomainError) throw destinationError
        // A 412 streaming PUT can leave one poisoned keep-alive socket in
        // MinIO. Retry GET only before a response body exists, so the caller's
        // destination can never contain partial bytes from the first attempt.
        if (attempt === 0 && source === undefined && isS3Ambiguous(error, requestSignal)) continue
        throw new ObjectStoreFailureErrorV2('Unable to download S3 object', error, 's3')
      } finally {
        source?.destroy()
      }
    }
    throw new ObjectStoreFailureErrorV2('Unable to download S3 object', undefined, 's3')
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    throwIfAborted(context.signal)
    const requestSignal = requestAbortSignal(context.signal, this.#requestTimeoutMs)
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), {
        abortSignal: requestSignal,
      })
      throwIfAborted(context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      throw new ObjectStoreFailureErrorV2('Unable to access S3 bucket', error, 's3')
    }
  }
}

function buildS3ClientConfig(config: S3ConditionalObjectStoreV2Config): S3ClientConfig {
  const result: S3ClientConfig = {
    forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
    maxAttempts: 1,
    region: config.region,
  }
  if (config.endpoint) result.endpoint = config.endpoint
  if (config.accessKeyId && config.secretAccessKey) {
    result.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }
  }
  return result
}

function requestAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function bodyToReadable(body: GetObjectCommandOutput['Body']): Readable {
  if (!body) return Readable.from([])
  if (body instanceof Readable) return body
  if (Symbol.asyncIterator in body) {
    return Readable.from(body as AsyncIterable<Uint8Array>)
  }
  throw new ObjectStoreFailureErrorV2('S3 returned a non-streaming object body', undefined, 's3')
}

function isS3AlreadyExists(error: unknown): boolean {
  return s3Status(error) === 412 || errorName(error) === 'PreconditionFailed'
}

function isS3HeadMissing(error: unknown): boolean {
  if (errorName(error) === 'NoSuchBucket') return false
  return (
    s3Status(error) === 404 || errorName(error) === 'NotFound' || errorName(error) === 'NoSuchKey'
  )
}

function isS3GetMissing(error: unknown): boolean {
  if (errorName(error) === 'NoSuchBucket') return false
  return (
    errorName(error) === 'NoSuchKey' || errorName(error) === 'NotFound' || s3Status(error) === 404
  )
}

function isS3Ambiguous(error: unknown, requestSignal: AbortSignal): boolean {
  const status = s3Status(error)
  if (status === 409 || (status !== undefined && status >= 500)) return true
  if (requestSignal.aborted) return true
  const name = errorName(error)
  const code = errorCode(error)
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'RequestTimeout' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  )
}

function s3Status(error: unknown): number | undefined {
  if (error instanceof S3ServiceException) return error.$metadata.httpStatusCode
  if (typeof error !== 'object' || error === null) return undefined
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function requiredString(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}
