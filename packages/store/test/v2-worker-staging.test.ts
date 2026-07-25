import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import type {
  ConditionalCreateInput,
  ConditionalCreateResult,
  ObjectDownloadInputV2,
  ObjectHeadV2,
  V2OperationContext,
  WorkerStagingHeadV1,
  WorkerStagingObjectStoreV1,
  WorkerStagingPresignInputV1,
} from '../src/index.js'
import {
  WORKER_STAGING_JSONL_MEDIA_TYPE,
  WorkerStagingStoreV1,
  workerStagingKeyV1,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Worker staging exact data plane', () => {
  test('builds only exact attempt-scoped input/output keys', () => {
    const jobId = `job_${'1'.repeat(64)}`
    expect(workerStagingKeyV1({ jobId, attempt: 2, logicalName: 'input' })).toBe(
      `staging/worker/v1/${jobId}/2/input.jsonl`,
    )
    expect(workerStagingKeyV1({ jobId, attempt: 2, logicalName: 'output' })).toBe(
      `staging/worker/v1/${jobId}/2/output.jsonl`,
    )
    expect(() =>
      workerStagingKeyV1({ jobId: '../objects/v2/escape', attempt: 1, logicalName: 'input' }),
    ).toThrow()
    expect(() => workerStagingKeyV1({ jobId, attempt: 0, logicalName: 'input' })).toThrow()
  })

  test('conditionally creates input, signs exact methods, verifies output, and deletes exact keys', async () => {
    const provider = new MemoryStagingProvider()
    const store = await createStore(provider)
    const jobId = `job_${'2'.repeat(64)}`
    const inputBytes = Buffer.from('{"input":true}\n')
    const input = await store.createInput(
      { jobId, attempt: 1 },
      chunks(inputBytes.subarray(0, 4), inputBytes.subarray(4)),
    )
    expect(input).toMatchObject({
      key: `staging/worker/v1/${jobId}/1/input.jsonl`,
      mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
      size: inputBytes.byteLength,
      digest: sha256(inputBytes),
    })
    await expect(store.createInput({ jobId, attempt: 1 }, chunks(inputBytes))).resolves.toEqual(
      input,
    )

    const source = await store.signRead({ jobId, attempt: 1 }, input)
    const target = await store.createOutputTarget({ jobId, attempt: 1 }, 512)
    expect(source.readUrl).toBe(`signed:GET:${input.key}`)
    expect(target.writeUrl).toBe(`signed:PUT:${target.key}`)
    expect(provider.signed.map(({ method, key }) => [method, key])).toEqual([
      ['GET', input.key],
      ['PUT', target.key],
    ])

    const outputBytes = Buffer.from(
      `{"record_id":"rec_${'3'.repeat(64)}","record_digest":"${'4'.repeat(64)}"}\n`,
    )
    provider.put(target.key, outputBytes, WORKER_STAGING_JSONL_MEDIA_TYPE)
    const read: Uint8Array[] = []
    for await (const chunk of store.readExact(
      { jobId, attempt: 1, logicalName: 'output' },
      { expectedSize: outputBytes.byteLength, expectedDigest: sha256(outputBytes) },
    )) {
      read.push(chunk)
    }
    expect(Buffer.concat(read)).toEqual(outputBytes)

    await store.deleteExact({ jobId, attempt: 1, logicalName: 'input' })
    await store.deleteExact({ jobId, attempt: 1, logicalName: 'output' })
    expect(provider.deleted).toEqual([input.key, target.key])
    await expect(store.statExact({ jobId, attempt: 1, logicalName: 'output' })).resolves.toBeNull()
  })

  test('fails closed on output metadata and digest mismatches', async () => {
    const provider = new MemoryStagingProvider()
    const store = await createStore(provider)
    const jobId = `job_${'5'.repeat(64)}`
    const key = workerStagingKeyV1({ jobId, attempt: 1, logicalName: 'output' })
    provider.put(key, Buffer.from('payload'), 'text/plain')
    await expect(
      collect(store.readExact({ jobId, attempt: 1, logicalName: 'output' })),
    ).rejects.toMatchObject({ code: 'integrity_error' })

    provider.put(key, Buffer.from('payload'), WORKER_STAGING_JSONL_MEDIA_TYPE)
    await expect(
      collect(
        store.readExact(
          { jobId, attempt: 1, logicalName: 'output' },
          { expectedDigest: '0'.repeat(64) },
        ),
      ),
    ).rejects.toMatchObject({ code: 'integrity_error' })
    await expect(
      collect(store.readExact({ jobId, attempt: 1, logicalName: 'output' }, { expectedSize: 1 })),
    ).rejects.toMatchObject({ code: 'integrity_error' })
  })
})

async function createStore(provider: MemoryStagingProvider): Promise<WorkerStagingStoreV1> {
  const root = await mkdtemp(join(tmpdir(), 'databench-worker-staging-test-'))
  roots.push(root)
  return new WorkerStagingStoreV1({
    objectStore: provider,
    tempRoot: root,
    maxBytes: 1024,
    signedUrlTtlMs: 60_000,
  })
}

class MemoryStagingProvider implements WorkerStagingObjectStoreV1 {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>()
  readonly signed: WorkerStagingPresignInputV1[] = []
  readonly deleted: string[] = []

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    if (this.objects.has(input.key)) return { status: 'already_exists' }
    const bytes = await readableBytes(input.body())
    this.put(input.key, bytes, input.contentType)
    return { status: 'created' }
  }

  async head(key: string): Promise<Readonly<ObjectHeadV2> | null> {
    const value = this.objects.get(key)
    return value ? { size: value.bytes.byteLength } : null
  }

  async headStaging(key: string): Promise<Readonly<WorkerStagingHeadV1> | null> {
    const value = this.objects.get(key)
    return value ? { size: value.bytes.byteLength, contentType: value.contentType } : null
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    const value = this.objects.get(input.key)
    if (!value) return 'not_found'
    await new Promise<void>((resolve, reject) =>
      input.destination.end(value.bytes, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    )
    return 'downloaded'
  }

  async presignStaging(input: WorkerStagingPresignInputV1): Promise<string> {
    this.signed.push(input)
    return `signed:${input.method}:${input.key}`
  }

  async deleteStaging(key: string, _context?: V2OperationContext): Promise<void> {
    this.deleted.push(key)
    this.objects.delete(key)
  }

  async ping(): Promise<void> {}

  put(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType })
  }
}

async function* chunks(...values: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  yield* values
}

async function readableBytes(source: Readable): Promise<Buffer> {
  const values: Buffer[] = []
  for await (const chunk of source) values.push(Buffer.from(chunk))
  return Buffer.concat(values)
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Buffer[] = []
  for await (const chunk of source) values.push(Buffer.from(chunk))
  return Buffer.concat(values)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
