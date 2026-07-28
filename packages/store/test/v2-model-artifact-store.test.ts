import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createArtifactHasher } from '@databench/hashing'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  ConditionalCreateInput,
  ConditionalCreateResult,
  ObjectDownloadInputV2,
  V2OperationContext,
} from '../src/v2/contracts.js'
import {
  MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
  ModelArtifactStoreV1,
} from '../src/v2/model-artifact-store.js'
import { V2TempStore } from '../src/v2/temp-store.js'
import type {
  WorkerStagingHeadV1,
  WorkerStagingObjectStoreV1,
  WorkerStagingPresignInputV1,
} from '../src/v2/worker-staging.js'

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000'

describe('ModelArtifactStoreV1', () => {
  let root: string
  let objects: MemoryArtifactObjectStore
  let store: ModelArtifactStoreV1

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'databench-model-artifact-store-'))
    objects = new MemoryArtifactObjectStore()
    store = new ModelArtifactStoreV1({
      objectStore: objects,
      tempStore: new V2TempStore({ tempRoot: root, safetyMarginBytes: 0 }),
      signedUrlTtlMs: 60_000,
      maxBytes: 1024 * 1024,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('publishes exact staging bytes immutably and replays an existing object', async () => {
    const target = await store.createStagingTarget(IMPORT_ID)
    expect(target).toEqual({
      key: `staging/swift-artifact/v1/${IMPORT_ID}/archive.tar.zst`,
      mediaType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
      maxSizeBytes: 1024 * 1024,
      writeUrl: `https://staging.invalid/${IMPORT_ID}/archive.tar.zst`,
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    })

    const archive = Buffer.from('deterministic tar zstd bytes')
    const archiveDigest = digest(archive)
    objects.putStaging(target.key, archive, MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE)
    const created = await store.finalizeStaging(IMPORT_ID, {
      archiveDigest,
      archiveSizeBytes: archive.byteLength,
    })
    expect(created).toEqual({
      archiveDigest,
      archiveSizeBytes: archive.byteLength,
      objectKey: `objects/v2/model-artifact-v1/${archiveDigest.slice(0, 2)}/${archiveDigest}.tar.zst`,
      created: true,
    })

    const replay = await store.finalizeStaging(IMPORT_ID, {
      archiveDigest,
      archiveSizeBytes: archive.byteLength,
    })
    expect(replay).toMatchObject({ objectKey: created.objectKey, created: false })
    expect(Buffer.concat(await collect(store.read(created)))).toEqual(archive)

    await store.cleanupStaging(IMPORT_ID)
    expect(objects.staging.has(target.key)).toBe(false)
    expect(objects.final.get(created.objectKey)?.bytes).toEqual(archive)
  })

  test('rejects staging identity, media type, and key mismatch without publishing', async () => {
    const target = await store.createStagingTarget(IMPORT_ID, 128)
    const archive = Buffer.from('archive')
    objects.putStaging(target.key, archive, 'application/octet-stream')
    await expect(
      store.finalizeStaging(IMPORT_ID, {
        archiveDigest: digest(archive),
        archiveSizeBytes: archive.byteLength,
      }),
    ).rejects.toThrow('unexpected media type')

    objects.putStaging(target.key, archive, MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE)
    await expect(
      store.finalizeStaging(IMPORT_ID, {
        archiveDigest: '0'.repeat(64),
        archiveSizeBytes: archive.byteLength,
      }),
    ).rejects.toThrow('declared identity')
    expect(objects.final.size).toBe(0)
    await expect(store.createStagingTarget('../escape')).rejects.toThrow('lowercase UUID')
  })
})

class MemoryArtifactObjectStore implements WorkerStagingObjectStoreV1 {
  readonly staging = new Map<string, { readonly bytes: Buffer; readonly contentType: string }>()
  readonly final = new Map<string, { readonly bytes: Buffer; readonly contentType: string }>()

  putStaging(key: string, bytes: Buffer, contentType: string): void {
    this.staging.set(key, { bytes: Buffer.from(bytes), contentType })
  }

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    if (this.final.has(input.key)) return { status: 'already_exists' }
    const bytes = Buffer.concat(await collect(input.body()))
    if (bytes.byteLength !== input.contentLength) {
      return { status: 'failure', error: new Error('content length mismatch') }
    }
    this.final.set(input.key, { bytes, contentType: input.contentType })
    return { status: 'created' }
  }

  async head(key: string) {
    const object = this.final.get(key)
    return object ? { size: object.bytes.byteLength } : null
  }

  async headStaging(key: string): Promise<Readonly<WorkerStagingHeadV1> | null> {
    const object = this.staging.get(key)
    return object ? { size: object.bytes.byteLength, contentType: object.contentType } : null
  }

  async presignStaging(input: WorkerStagingPresignInputV1): Promise<string> {
    const suffix = input.key.split('/').slice(-2).join('/')
    return `https://staging.invalid/${suffix}`
  }

  async deleteStaging(key: string): Promise<void> {
    this.staging.delete(key)
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    const object = this.staging.get(input.key) ?? this.final.get(input.key)
    if (!object) return 'not_found'
    await pipeline(Readable.from([object.bytes]), input.destination)
    return 'downloaded'
  }

  async ping(_context: V2OperationContext = {}): Promise<void> {}
}

function digest(bytes: Uint8Array): string {
  const hasher = createArtifactHasher()
  hasher.update(bytes)
  return hasher.digestHex()
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return chunks
}
