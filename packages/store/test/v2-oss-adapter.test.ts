import { PassThrough, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, test, vi } from 'vitest'
import { ObjectStoreFailureErrorV2 } from '../src/v2/contracts.js'
import {
  DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS,
  OssBucketVersioningUnsupportedErrorV2,
  type OssConditionalClientV2,
  OssConditionalObjectStoreV2,
} from '../src/v2/oss-adapter.js'

type PutStreamOptions = Parameters<OssConditionalClientV2['putStream']>[2]
type GetOptions = Parameters<OssConditionalClientV2['get']>[2]
type ObjectMetaResult = Awaited<ReturnType<OssConditionalClientV2['getObjectMeta']>>
type BucketInfoResult = Awaited<ReturnType<OssConditionalClientV2['getBucketInfo']>>

interface PutCall {
  readonly name: string
  readonly options: PutStreamOptions
  body?: Buffer
}

class FakeOssClient implements OssConditionalClientV2 {
  readonly putCalls: PutCall[] = []
  readonly getCalls: Array<{ readonly name: string; readonly options: GetOptions }> = []
  readonly metaCalls: Array<{ readonly name: string; readonly options: GetOptions }> = []
  readonly bucketInfoCalls: Array<{ readonly name: string; readonly options: GetOptions }> = []
  bucketInfoResult: BucketInfoResult = { bucket: {} }
  bucketInfoError: unknown
  putError: unknown
  putStatus = 200
  objectMetaResult: ObjectMetaResult = {
    res: { status: 200, headers: { 'content-length': '0' } },
  }
  objectMetaError: unknown
  downloadBytes = Buffer.alloc(0)
  downloadError: unknown
  getOverride:
    | ((name: string, destination: Writable, options: GetOptions) => Promise<unknown>)
    | undefined

  async putStream(
    name: string,
    stream: Readable,
    options: PutStreamOptions,
  ): Promise<{
    readonly res: {
      readonly status: number
      readonly headers: Readonly<Record<string, never>>
    }
  }> {
    const call: PutCall = { name, options }
    this.putCalls.push(call)
    call.body = await readAll(stream)
    if (this.putError !== undefined) throw this.putError
    return { res: { status: this.putStatus, headers: {} } }
  }

  async get(name: string, destination: Writable, options: GetOptions): Promise<unknown> {
    this.getCalls.push({ name, options })
    if (this.getOverride) return await this.getOverride(name, destination, options)
    if (this.downloadError !== undefined) throw this.downloadError
    await pipeline(Readable.from([this.downloadBytes]), destination)
    return {}
  }

  async getObjectMeta(name: string, options: GetOptions): Promise<ObjectMetaResult> {
    this.metaCalls.push({ name, options })
    if (this.objectMetaError !== undefined) throw this.objectMetaError
    return this.objectMetaResult
  }

  async getBucketInfo(name: string, options: GetOptions): Promise<BucketInfoResult> {
    this.bucketInfoCalls.push({ name, options })
    if (this.bucketInfoError !== undefined) throw this.bucketInfoError
    return this.bucketInfoResult
  }
}

describe('OssConditionalObjectStoreV2 conditional create', () => {
  test('uses forbid-overwrite, a caller-owned stream and the fixed request timeout', async () => {
    const client = new FakeOssClient()
    const store = createStore(client)
    const result = await store.conditionalCreate({
      key: 'objects/v2/artifact.parquet',
      contentType: 'application/vnd.apache.parquet',
      contentLength: 7,
      body: () => Readable.from([Buffer.from('payload')]),
    })

    expect(result).toEqual({ status: 'created' })
    expect(client.bucketInfoCalls).toEqual([
      {
        name: 'databench',
        options: { timeout: DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS },
      },
    ])
    expect(client.putCalls).toHaveLength(1)
    expect(client.putCalls[0]).toMatchObject({
      name: 'objects/v2/artifact.parquet',
      options: {
        contentLength: 7,
        headers: { 'x-oss-forbid-overwrite': 'true' },
        mime: 'application/vnd.apache.parquet',
        timeout: DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS,
      },
      body: Buffer.from('payload'),
    })
  })

  test.each([
    'Enabled',
    'Suspended',
    'unexpected',
  ])('fails closed before PUT when bucket versioning is %s', async (versioning) => {
    const client = new FakeOssClient()
    client.bucketInfoResult = { bucket: { Versioning: versioning } }
    const result = await createStore(client).conditionalCreate(validCreateInput())

    expect(result.status).toBe('failure')
    if (result.status === 'failure') {
      expect(result.error).toBeInstanceOf(OssBucketVersioningUnsupportedErrorV2)
    }
    expect(client.putCalls).toHaveLength(0)
  })

  test('fails closed when bucket info does not contain a bucket object', async () => {
    const client = new FakeOssClient()
    client.bucketInfoResult = {}
    const result = await createStore(client).conditionalCreate(validCreateInput())

    expect(result.status).toBe('failure')
    if (result.status === 'failure') {
      expect(result.error).toBeInstanceOf(OssBucketVersioningUnsupportedErrorV2)
    }
    expect(client.putCalls).toHaveLength(0)
  })

  test.each([
    {
      name: 'the exact OSS collision',
      error: ossError('FileAlreadyExistsError', 409, 'FileAlreadyExists'),
      status: 'already_exists',
    },
    {
      name: 'the alternate OSS object collision',
      error: ossError('ObjectAlreadyExistsError', 409, 'ObjectAlreadyExists'),
      status: 'already_exists',
    },
    {
      name: 'an unrelated 409',
      error: ossError('OperationAbortedError', 409, 'OperationAborted'),
      status: 'failure',
    },
    {
      name: 'a 412',
      error: ossError('PreconditionFailedError', 412, 'PreconditionFailed'),
      status: 'failure',
    },
    {
      name: 'an authorization failure',
      error: ossError('AccessDeniedError', 403, 'AccessDenied'),
      status: 'failure',
    },
    {
      name: 'a server failure',
      error: ossError('InternalError', 500, 'InternalError'),
      status: 'ambiguous',
    },
    {
      name: 'a transport failure',
      error: ossError('RequestError', -1, 'RequestError'),
      status: 'ambiguous',
    },
    {
      name: 'a response timeout without status or code',
      error: Object.assign(new Error('timed out'), { name: 'ResponseTimeoutError' }),
      status: 'ambiguous',
    },
  ])('maps $name to $status', async ({ error, status }) => {
    const client = new FakeOssClient()
    client.putError = error

    await expect(createStore(client).conditionalCreate(validCreateInput())).resolves.toMatchObject({
      status,
    })
  })

  test('rejects a pre-aborted request without touching OSS', async () => {
    const client = new FakeOssClient()
    const controller = new AbortController()
    controller.abort('stop')

    await expect(
      createStore(client).conditionalCreate({
        ...validCreateInput(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(client.bucketInfoCalls).toHaveLength(0)
    expect(client.putCalls).toHaveLength(0)
  })

  test('destroys an in-flight upload stream and reports cancellation, not transport success', async () => {
    const client = new FakeOssClient()
    const source = new PassThrough()
    const controller = new AbortController()
    const pending = createStore(client).conditionalCreate({
      ...validCreateInput(),
      body: () => source,
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(client.putCalls).toHaveLength(1))
    controller.abort('stop')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(source.destroyed).toBe(true)
  })

  test('treats a local upload stream error as failure rather than ambiguous transport', async () => {
    const client = new FakeOssClient()
    const source = new PassThrough()
    const pending = createStore(client).conditionalCreate({
      ...validCreateInput(),
      body: () => source,
    })
    await vi.waitFor(() => expect(client.putCalls).toHaveLength(1))
    const localError = new Error('local read failed')
    source.destroy(localError)

    const result = await pending
    expect(result).toEqual({ status: 'failure', error: localError })
  })
})

describe('OssConditionalObjectStoreV2 read operations', () => {
  test('heads an object without downloading it', async () => {
    const client = new FakeOssClient()
    client.objectMetaResult = {
      res: { status: 200, headers: { 'content-length': '123' } },
    }

    await expect(createStore(client).head('object')).resolves.toEqual({ size: 123 })
    expect(client.metaCalls).toEqual([
      { name: 'object', options: { timeout: DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS } },
    ])
  })

  test('only maps NoSuchKey to a missing object', async () => {
    const missing = new FakeOssClient()
    missing.objectMetaError = ossError('NoSuchKeyError', 404, 'NoSuchKey')
    await expect(createStore(missing).head('missing')).resolves.toBeNull()

    const missingBucket = new FakeOssClient()
    missingBucket.objectMetaError = ossError('NoSuchBucketError', 404, 'NoSuchBucket')
    await expect(createStore(missingBucket).head('missing')).rejects.toBeInstanceOf(
      ObjectStoreFailureErrorV2,
    )
  })

  test('downloads into the caller-owned writable without buffering the object', async () => {
    const client = new FakeOssClient()
    client.downloadBytes = Buffer.from('downloaded')
    const destination = new CollectingWritable()

    await expect(createStore(client).download({ key: 'object', destination })).resolves.toBe(
      'downloaded',
    )
    expect(destination.bytes()).toEqual(Buffer.from('downloaded'))
    expect(client.getCalls).toEqual([
      { name: 'object', options: { timeout: DEFAULT_V2_OSS_REQUEST_TIMEOUT_MS } },
    ])
  })

  test('returns not_found only for NoSuchKey', async () => {
    const client = new FakeOssClient()
    client.downloadError = ossError('NoSuchKeyError', 404, 'NoSuchKey')

    await expect(
      createStore(client).download({
        key: 'missing',
        destination: new CollectingWritable(),
      }),
    ).resolves.toBe('not_found')
  })

  test('preserves a typed local destination error', async () => {
    const client = new FakeOssClient()
    client.downloadBytes = Buffer.from('downloaded')
    const localError = Object.assign(new Error('destination limit exceeded'), {
      name: 'LocalDestinationError',
    })
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(localError)
      },
    })

    await expect(createStore(client).download({ key: 'object', destination })).rejects.toBe(
      localError,
    )
  })

  test('destroys a blocked download destination when cancelled', async () => {
    const client = new FakeOssClient()
    client.getOverride = async (_name, destination) =>
      await new Promise((_, reject) => {
        destination.once('error', reject)
      })
    const destination = new PassThrough()
    destination.resume()
    const controller = new AbortController()
    const pending = createStore(client).download({
      key: 'object',
      destination,
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(client.getCalls).toHaveLength(1))
    controller.abort('stop')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(destination.destroyed).toBe(true)
  })

  test('ping fails closed for a versioned bucket', async () => {
    const client = new FakeOssClient()
    client.bucketInfoResult = { bucket: { Versioning: 'Suspended' } }

    await expect(createStore(client).ping()).rejects.toBeInstanceOf(
      OssBucketVersioningUnsupportedErrorV2,
    )
  })
})

class CollectingWritable extends Writable {
  readonly #chunks: Buffer[] = []

  override _write(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.from(chunk))
    callback()
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks)
  }
}

function createStore(client: OssConditionalClientV2): OssConditionalObjectStoreV2 {
  return new OssConditionalObjectStoreV2({
    bucket: 'databench',
    region: 'oss-cn-hangzhou',
    accessKeyId: 'test-access-key',
    accessKeySecret: 'test-secret',
    client,
  })
}

function validCreateInput() {
  return {
    key: 'objects/v2/object',
    contentType: 'application/octet-stream',
    contentLength: 7,
    body: () => Readable.from([Buffer.from('payload')]),
  }
}

function ossError(name: string, status: number, code: string): Error {
  return Object.assign(new Error(name), { name, status, code })
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
