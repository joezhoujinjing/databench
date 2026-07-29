import { createRequire } from 'node:module'
import type { Readable, Writable } from 'node:stream'
import { DomainError, ServiceUnavailableError } from '@databench/schema'
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

export const DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS = 30_000

interface OssRequestOptionsV2 {
  readonly timeout: number
}

interface OssPutStreamOptionsV2 extends OssRequestOptionsV2 {
  readonly contentLength: number
  readonly headers: Readonly<Record<string, string>>
  readonly mime: string
}

interface OssResponseV2 {
  readonly status: number
  readonly headers: Readonly<Record<string, string | number | undefined>>
}

interface OssPutResultV2 {
  readonly res: OssResponseV2
}

interface OssBucketInfoResultV2 {
  readonly bucket?: {
    readonly Versioning?: unknown
  }
}

interface OssObjectMetaResultV2 {
  readonly res: OssResponseV2
}

export interface OssConditionalClientV2 {
  putStream(name: string, stream: Readable, options: OssPutStreamOptionsV2): Promise<OssPutResultV2>
  get(name: string, destination: Writable, options: OssRequestOptionsV2): Promise<unknown>
  getObjectMeta(name: string, options: OssRequestOptionsV2): Promise<OssObjectMetaResultV2>
  getBucketInfo(name: string, options: OssRequestOptionsV2): Promise<OssBucketInfoResultV2>
  signatureUrl?(name: string, options: Readonly<Record<string, unknown>>): string
  delete?(name: string, options: OssRequestOptionsV2): Promise<unknown>
}

interface OssClientOptionsV2 {
  readonly bucket: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
  readonly region?: string
  readonly endpoint?: string
  readonly secure?: boolean
  readonly internal?: boolean
  readonly retryMax: 0
  readonly timeout: number
}

type OssConstructorV2 = new (options: OssClientOptionsV2) => OssConditionalClientV2

const nodeRequire = createRequire(import.meta.url)
const OSS = nodeRequire('ali-oss') as OssConstructorV2

export interface OssConditionalObjectStoreV2Config {
  readonly bucket: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
  readonly region?: string
  readonly endpoint?: string
  readonly secure?: boolean
  readonly internal?: boolean
  readonly requestTimeoutMs?: number
  readonly client?: OssConditionalClientV2
}

export class OssBucketVersioningUnsupportedErrorV2 extends ServiceUnavailableError {
  override readonly name: string = 'OssBucketVersioningUnsupportedErrorV2'

  constructor(versioning: unknown) {
    super(
      'OSS conditional create requires a bucket on which versioning has never been enabled',
      { provider: 'oss' },
      {
        cause: new TypeError(`Unsupported OSS bucket versioning state: ${String(versioning)}`),
      },
    )
  }
}

export class OssConditionalObjectStoreV2
  implements ConditionalObjectStoreV2, WorkerStagingObjectStoreV1
{
  readonly #config: OssConditionalObjectStoreV2Config
  readonly #bucket: string
  readonly #requestTimeoutMs: number
  #client: OssConditionalClientV2 | null

  constructor(config: OssConditionalObjectStoreV2Config) {
    this.#config = config
    this.#bucket = requiredString('bucket', config.bucket)
    this.#requestTimeoutMs = positiveSafeInteger(
      'requestTimeoutMs',
      config.requestTimeoutMs ?? DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS,
    )
    this.#client = config.client ?? null
  }

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    throwIfAborted(input.signal)
    try {
      await this.#assertVersioningDisabled(input.signal)
    } catch (error) {
      if (input.signal?.aborted) throw abortError(input.signal.reason)
      return { status: 'failure', error }
    }

    throwIfAborted(input.signal)
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) {
      return {
        status: 'failure',
        error: new TypeError(
          'OSS conditional create contentLength must be a non-negative safe integer',
        ),
      }
    }

    let body: Readable
    try {
      body = input.body()
    } catch (error) {
      if (input.signal?.aborted) throw abortError(input.signal.reason)
      return { status: 'failure', error }
    }

    let bodyError: unknown
    const onBodyError = (error: unknown): void => {
      bodyError = error
    }
    body.once('error', onBodyError)
    const removeAbortListener = destroyOnAbort(body, input.signal)

    try {
      throwIfAborted(input.signal)
      const result = await this.#oss().putStream(input.key, body, {
        contentLength: input.contentLength,
        headers: { 'x-oss-forbid-overwrite': 'true' },
        mime: input.contentType,
        timeout: this.#requestTimeoutMs,
      })
      throwIfAborted(input.signal)
      if (result.res.status !== 200) {
        return {
          status: 'failure',
          error: new TypeError(
            `OSS conditional create returned unexpected status ${result.res.status}`,
          ),
        }
      }
      return { status: 'created' }
    } catch (error) {
      if (input.signal?.aborted) throw abortError(input.signal.reason)
      if (isOssAlreadyExists(error)) return { status: 'already_exists' }
      if (bodyError !== undefined && isOssAmbiguous(bodyError)) {
        return { status: 'ambiguous', error: bodyError }
      }
      if (isOssAmbiguous(error)) return { status: 'ambiguous', error }
      if (bodyError !== undefined) return { status: 'failure', error: bodyError }
      return { status: 'failure', error }
    } finally {
      removeAbortListener()
      body.removeListener('error', onBodyError)
      body.destroy()
    }
  }

  async head(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<ObjectHeadV2> | null> {
    throwIfAborted(context.signal)
    try {
      const result = await this.#oss().getObjectMeta(key, {
        timeout: this.#requestTimeoutMs,
      })
      throwIfAborted(context.signal)
      return Object.freeze({ size: parseContentLength(result.res.headers) })
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      if (isOssMissingObject(error)) return null
      if (
        error instanceof ObjectStoreFailureErrorV2 ||
        error instanceof OssBucketVersioningUnsupportedErrorV2
      ) {
        throw error
      }
      throw new ObjectStoreFailureErrorV2('Unable to inspect OSS object', error, 'oss')
    }
  }

  async headStaging(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingHeadV1> | null> {
    throwIfAborted(context.signal)
    try {
      const result = await this.#oss().getObjectMeta(key, { timeout: this.#requestTimeoutMs })
      throwIfAborted(context.signal)
      const contentType = headerValue(result.res.headers, 'content-type')
      if (contentType === null) {
        throw new ObjectStoreFailureErrorV2(
          'OSS returned missing Worker staging content type',
          undefined,
          'oss',
        )
      }
      return Object.freeze({ size: parseContentLength(result.res.headers), contentType })
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      if (isOssMissingObject(error)) return null
      if (error instanceof ObjectStoreFailureErrorV2) throw error
      throw new ObjectStoreFailureErrorV2('Unable to inspect OSS staging object', error, 'oss')
    }
  }

  async presignStaging(input: WorkerStagingPresignInputV1): Promise<string> {
    const client = this.#oss()
    const signer = client.signatureUrl
    if (!signer) {
      throw new ObjectStoreFailureErrorV2(
        'OSS client cannot sign staging requests',
        undefined,
        'oss',
      )
    }
    try {
      return signer.call(client, input.key, {
        expires: positiveSafeInteger('expiresInSeconds', input.expiresInSeconds),
        method: input.method,
        'Content-Type': input.contentType,
        ...(input.ifNoneMatch === undefined ? {} : { 'If-None-Match': input.ifNoneMatch }),
      })
    } catch (error) {
      throw new ObjectStoreFailureErrorV2('Unable to sign OSS staging request', error, 'oss')
    }
  }

  async deleteStaging(key: string, context: V2OperationContext = {}): Promise<void> {
    throwIfAborted(context.signal)
    const client = this.#oss()
    const remove = client.delete
    if (!remove) {
      throw new ObjectStoreFailureErrorV2(
        'OSS client cannot delete staging objects',
        undefined,
        'oss',
      )
    }
    try {
      await remove.call(client, key, { timeout: this.#requestTimeoutMs })
      throwIfAborted(context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      if (isOssMissingObject(error)) return
      throw new ObjectStoreFailureErrorV2('Unable to delete OSS staging object', error, 'oss')
    }
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    throwIfAborted(input.signal)
    let destinationError: unknown
    let completed = false
    const onDestinationError = (error: unknown): void => {
      destinationError = error
    }
    input.destination.once('error', onDestinationError)
    const removeAbortListener = destroyOnAbort(input.destination, input.signal)

    try {
      throwIfAborted(input.signal)
      await this.#oss().get(input.key, input.destination, {
        timeout: this.#requestTimeoutMs,
      })
      throwIfAborted(input.signal)
      completed = true
      return 'downloaded'
    } catch (error) {
      if (input.signal?.aborted) throw abortError(input.signal.reason)
      if (isOssMissingObject(error)) return 'not_found'
      if (destinationError === error && !isOssAmbiguous(error)) throw error
      if (destinationError instanceof DomainError) throw destinationError
      throw new ObjectStoreFailureErrorV2('Unable to download OSS object', error, 'oss')
    } finally {
      removeAbortListener()
      input.destination.removeListener('error', onDestinationError)
      if (!completed) input.destination.destroy()
    }
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    throwIfAborted(context.signal)
    try {
      await this.#assertVersioningDisabled(context.signal)
      throwIfAborted(context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw abortError(context.signal.reason)
      if (
        error instanceof ObjectStoreFailureErrorV2 ||
        error instanceof OssBucketVersioningUnsupportedErrorV2
      ) {
        throw error
      }
      throw new ObjectStoreFailureErrorV2('Unable to access OSS bucket', error, 'oss')
    }
  }

  #oss(): OssConditionalClientV2 {
    this.#client ??= new OSS(buildOssClientOptions(this.#config, this.#requestTimeoutMs))
    return this.#client
  }

  async #assertVersioningDisabled(signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal)
    const result = await this.#oss().getBucketInfo(this.#bucket, {
      timeout: this.#requestTimeoutMs,
    })
    throwIfAborted(signal)
    // OSS ignores x-oss-forbid-overwrite when bucket versioning is Enabled or
    // Suspended. Missing Versioning is the only documented never-enabled state.
    if (typeof result.bucket !== 'object' || result.bucket === null) {
      throw new OssBucketVersioningUnsupportedErrorV2('unknown')
    }
    if (result.bucket.Versioning !== undefined) {
      throw new OssBucketVersioningUnsupportedErrorV2(result.bucket.Versioning)
    }
  }
}

function buildOssClientOptions(
  config: OssConditionalObjectStoreV2Config,
  requestTimeoutMs: number,
): OssClientOptionsV2 {
  return {
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    retryMax: 0,
    timeout: requestTimeoutMs,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.secure !== undefined ? { secure: config.secure } : {}),
    ...(config.internal !== undefined ? { internal: config.internal } : {}),
  }
}

function destroyOnAbort(stream: Readable | Writable, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => undefined
  const onAbort = (): void => {
    stream.destroy(abortError(signal.reason))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return () => signal.removeEventListener('abort', onAbort)
}

function isOssAlreadyExists(error: unknown): boolean {
  const code = ossCode(error)
  return (
    ossStatus(error) === 409 && (code === 'FileAlreadyExists' || code === 'ObjectAlreadyExists')
  )
}

function isOssMissingObject(error: unknown): boolean {
  return ossStatus(error) === 404 && ossCode(error) === 'NoSuchKey'
}

function isOssAmbiguous(error: unknown): boolean {
  const status = ossStatus(error)
  if (status === -1 || status === -2 || status === 408 || status === 429) return true
  if (status !== undefined && status >= 500) return true

  const name = errorName(error)
  const code = ossCode(error)
  return (
    name === 'RequestError' ||
    name === 'ResponseError' ||
    name === 'ConnectionTimeoutError' ||
    name === 'ResponseTimeoutError' ||
    name === 'SocketAssignTimeoutError' ||
    code === 'RequestError' ||
    code === 'ResponseError' ||
    code === 'ConnectionTimeoutError' ||
    code === 'ResponseTimeoutError' ||
    code === 'SocketAssignTimeoutError' ||
    code === 'RequestTimeout' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE'
  )
}

function ossStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function ossCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function parseContentLength(
  headers: Readonly<Record<string, string | number | undefined>>,
): number {
  const raw = headers['content-length']
  const size =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
        ? Number(raw)
        : Number.NaN
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ObjectStoreFailureErrorV2(
      'OSS returned an invalid object content length',
      undefined,
      'oss',
    )
  }
  return size
}

function headerValue(
  headers: Readonly<Record<string, string | number | undefined>>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === 'string' && value.length > 0 ? value : null
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
