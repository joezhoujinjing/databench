import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { hashArtifactBytes } from '@databench/hashing'
import { afterEach, describe, expect, test } from 'vitest'
import {
  type ConditionalCreateInput,
  type ConditionalCreateResult,
  EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
  EvaluationArtifactStoreV1,
  evaluationArchiveObjectKeyV1,
  evaluationArchiveStagingKeyV1,
  type ObjectDownloadInputV2,
  type ObjectHeadV2,
  type V2OperationContext,
  V2TempStore,
  type WorkerStagingHeadV1,
  type WorkerStagingObjectStoreV1,
  type WorkerStagingPresignInputV1,
} from '../src/index.js'

const roots: string[] = []
const RUN_ID = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('evaluation archive exact immutable data plane', () => {
  test('signs conditional attempt PUT, verifies BLAKE3, replays final create, and cleans exact staging', async () => {
    const provider = new MemoryProvider()
    const store = await createStore(provider)
    const ref = { attempt: 2, runId: RUN_ID }
    const bytes = Buffer.from('deterministic tar.zst bytes')
    const digest = hashArtifactBytes(bytes)
    const target = await store.staging.prepareUpload(ref, 1024)
    expect(target).toMatchObject({
      mediaType: EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
      maxSize: 1024,
      requiredHeaders: { 'content-type': 'application/zstd', 'if-none-match': '*' },
    })
    expect(provider.signed).toEqual([expect.objectContaining({ ifNoneMatch: '*', method: 'PUT' })])
    const stagingKey = evaluationArchiveStagingKeyV1(ref)
    provider.put(stagingKey, bytes, EVALUATION_ARCHIVE_MEDIA_TYPE_V1)

    const first = await store.finalize({
      ...ref,
      expectedDigest: digest,
      expectedSize: bytes.byteLength,
    })
    expect(first).toEqual({
      digest,
      key: evaluationArchiveObjectKeyV1(digest),
      size: bytes.byteLength,
    })
    await expect(
      store.finalize({ ...ref, expectedDigest: digest, expectedSize: bytes.byteLength }),
    ).resolves.toEqual(first)
    await store.staging.deleteExact(ref)
    expect(provider.deleted).toEqual([stagingKey])
    expect(provider.objects.has(first.key)).toBe(true)
  })

  test('rejects wrong digest, size, media type, and configured oversize', async () => {
    const provider = new MemoryProvider()
    const store = await createStore(provider, 32)
    const ref = { attempt: 1, runId: RUN_ID }
    const key = evaluationArchiveStagingKeyV1(ref)
    provider.put(key, Buffer.from('payload'), 'text/plain')
    await expect(
      store.finalize({ ...ref, expectedDigest: '0'.repeat(64), expectedSize: 7 }),
    ).rejects.toMatchObject({ code: 'integrity_error' })

    provider.put(key, Buffer.from('payload'), EVALUATION_ARCHIVE_MEDIA_TYPE_V1)
    await expect(
      store.finalize({ ...ref, expectedDigest: '0'.repeat(64), expectedSize: 7 }),
    ).rejects.toMatchObject({ code: 'integrity_error' })
    await expect(
      store.finalize({
        ...ref,
        expectedDigest: hashArtifactBytes(Buffer.from('payload')),
        expectedSize: 6,
      }),
    ).rejects.toMatchObject({ code: 'integrity_error' })
    await expect(store.staging.prepareUpload(ref, 33)).rejects.toMatchObject({
      code: 'resource_limit',
    })
  })

  test('does not issue result upload capabilities longer than 15 minutes', async () => {
    const provider = new MemoryProvider()
    const root = await mkdtemp(join(tmpdir(), 'databench-evaluation-archive-test-'))
    roots.push(root)
    expect(
      () =>
        new EvaluationArtifactStoreV1({
          maxBytes: 1024,
          objectStore: provider,
          signedUrlTtlMs: 15 * 60 * 1000 + 1,
          tempStore: new V2TempStore({ safetyMarginBytes: 0, tempRoot: root }),
        }),
    ).toThrow('must not exceed')
  })
})

async function createStore(provider: MemoryProvider, maxBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'databench-evaluation-archive-test-'))
  roots.push(root)
  return new EvaluationArtifactStoreV1({
    maxBytes,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
    objectStore: provider,
    signedUrlTtlMs: 15 * 60 * 1000,
    tempStore: new V2TempStore({ safetyMarginBytes: 0, tempRoot: root }),
  })
}

class MemoryProvider implements WorkerStagingObjectStoreV1 {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>()
  readonly signed: WorkerStagingPresignInputV1[] = []
  readonly deleted: string[] = []

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    if (this.objects.has(input.key)) return { status: 'already_exists' }
    this.put(input.key, await readableBytes(input.body()), input.contentType)
    return { status: 'created' }
  }

  async head(key: string): Promise<Readonly<ObjectHeadV2> | null> {
    const value = this.objects.get(key)
    return value ? { size: value.bytes.byteLength } : null
  }

  async headStaging(key: string): Promise<Readonly<WorkerStagingHeadV1> | null> {
    const value = this.objects.get(key)
    return value ? { contentType: value.contentType, size: value.bytes.byteLength } : null
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
    return `https://objects.invalid/${encodeURIComponent(input.key)}`
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

async function readableBytes(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
