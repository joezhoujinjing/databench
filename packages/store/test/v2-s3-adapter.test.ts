import { PassThrough, Readable, Writable } from 'node:stream'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { describe, expect, test, vi } from 'vitest'
import { ObjectStoreFailureErrorV2 } from '../src/v2/contracts.js'
import { S3ConditionalObjectStoreV2 } from '../src/v2/s3-adapter.js'

interface SendOptions {
  readonly abortSignal?: AbortSignal
}

interface SendCall {
  readonly command: unknown
  readonly options: SendOptions | undefined
}

type SendHandler = (command: unknown, options: SendOptions | undefined) => Promise<unknown>

class FakeS3Client {
  readonly calls: SendCall[] = []

  constructor(readonly handler: SendHandler) {}

  async send(command: unknown, options?: SendOptions): Promise<unknown> {
    this.calls.push({ command, options })
    return await this.handler(command, options)
  }
}

describe('S3ConditionalObjectStoreV2 conditional create', () => {
  test('sets IfNoneMatch=* and streams the caller-owned body', async () => {
    const client = new FakeS3Client(async () => ({}))
    const source = Readable.from([Buffer.from('payload')])

    await expect(
      createStore(client).conditionalCreate({
        key: 'objects/v2/artifact.parquet',
        contentType: 'application/vnd.apache.parquet',
        contentLength: 7,
        body: () => source,
      }),
    ).resolves.toEqual({ status: 'created' })

    expect(client.calls).toHaveLength(1)
    const call = client.calls[0]
    expect(call?.command).toBeInstanceOf(PutObjectCommand)
    expect((call?.command as PutObjectCommand).input).toMatchObject({
      Body: source,
      Bucket: 'databench',
      ContentLength: 7,
      ContentType: 'application/vnd.apache.parquet',
      IfNoneMatch: '*',
      Key: 'objects/v2/artifact.parquet',
    })
    expect(call?.options?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  test.each([
    {
      name: 'a successful conditional create',
      error: undefined,
      status: 'created',
    },
    {
      name: 'the exact precondition collision',
      error: s3Error('PreconditionFailed', 412),
      status: 'already_exists',
    },
    {
      name: 'a conditional request race',
      error: s3Error('ConditionalRequestConflict', 409),
      status: 'ambiguous',
    },
    {
      name: 'a response-lost server failure',
      error: s3Error('InternalError', 500),
      status: 'ambiguous',
    },
    {
      name: 'a socket reset',
      error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
      status: 'ambiguous',
    },
    {
      name: 'a deterministic authorization failure',
      error: s3Error('AccessDenied', 403),
      status: 'failure',
    },
  ])('maps $name to $status', async ({ error, status }) => {
    const client = new FakeS3Client(async () => {
      if (error !== undefined) throw error
      return {}
    })

    await expect(createStore(client).conditionalCreate(validCreateInput())).resolves.toMatchObject({
      status,
    })
  })

  test('rejects a pre-aborted create before constructing a body or calling S3', async () => {
    const client = new FakeS3Client(async () => ({}))
    const body = vi.fn(() => Readable.from([Buffer.from('payload')]))
    const controller = new AbortController()
    controller.abort('stop')

    await expect(
      createStore(client).conditionalCreate({
        ...validCreateInput(),
        body,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(body).not.toHaveBeenCalled()
    expect(client.calls).toHaveLength(0)
  })

  test('classifies an in-flight caller abort as ambiguous and destroys the upload stream', async () => {
    const client = new FakeS3Client(
      async (_command, options) =>
        await new Promise((_, reject) => {
          options?.abortSignal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        }),
    )
    const source = new Readable({ read() {} })
    const controller = new AbortController()
    const pending = createStore(client).conditionalCreate({
      ...validCreateInput(),
      body: () => source,
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(client.calls).toHaveLength(1))
    controller.abort('stop')

    await expect(pending).resolves.toMatchObject({ status: 'ambiguous' })
    expect(source.destroyed).toBe(true)
  })

  test('does not let an ambiguous SDK wrapper hide a local upload stream failure', async () => {
    const localError = new Error('local read failed')
    const source = new PassThrough()
    const client = new FakeS3Client(async (command) => {
      const body = (command as PutObjectCommand).input.Body
      expect(body).toBe(source)
      source.destroy(localError)
      await new Promise<void>((resolve) => setImmediate(resolve))
      throw s3Error('InternalError', 500)
    })

    await expect(
      createStore(client).conditionalCreate({
        ...validCreateInput(),
        body: () => source,
      }),
    ).resolves.toEqual({ status: 'failure', error: localError })
  })
})

describe('S3ConditionalObjectStoreV2 read operations', () => {
  test('only maps NoSuchKey to a missing HEAD result', async () => {
    const missing = new FakeS3Client(async (command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand)
      throw s3Error('NoSuchKey', 404)
    })
    await expect(createStore(missing).head('missing')).resolves.toBeNull()

    const missingBucket = new FakeS3Client(async () => {
      throw s3Error('NoSuchBucket', 404)
    })
    await expect(createStore(missingBucket).head('missing')).rejects.toBeInstanceOf(
      ObjectStoreFailureErrorV2,
    )
  })

  test('streams GET chunks into the caller-owned destination', async () => {
    const client = new FakeS3Client(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand)
      return {
        Body: Readable.from([Buffer.from('streamed-'), Buffer.from('download')]),
      }
    })
    const destination = new CollectingWritable()

    await expect(createStore(client).download({ key: 'object', destination })).resolves.toBe(
      'downloaded',
    )
    expect(destination.bytes()).toEqual(Buffer.from('streamed-download'))
  })

  test('does not mistake a missing bucket for a missing object during GET', async () => {
    const providerError = s3Error('NoSuchBucket', 404)
    const client = new FakeS3Client(async () => {
      throw providerError
    })

    await expect(
      createStore(client).download({
        key: 'missing',
        destination: new CollectingWritable(),
      }),
    ).rejects.toMatchObject({
      name: 'ObjectStoreFailureErrorV2',
      cause: providerError,
    })
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

function createStore(client: FakeS3Client): S3ConditionalObjectStoreV2 {
  return new S3ConditionalObjectStoreV2({
    bucket: 'databench',
    region: 'us-east-1',
    client: client as unknown as S3Client,
  })
}

function validCreateInput() {
  return {
    key: 'objects/v2/artifact.parquet',
    contentType: 'application/vnd.apache.parquet',
    contentLength: 7,
    body: () => Readable.from([Buffer.from('payload')]),
  }
}

function s3Error(
  name: string,
  status: number,
): Error & {
  readonly $metadata: { readonly httpStatusCode: number }
} {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  })
}
