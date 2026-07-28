import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3'
import { V2Dataset } from '@databench/engine'
import { createArtifactHasher } from '@databench/hashing'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  FileBackedV2Store,
  MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
  ModelArtifactStoreV1,
  S3ConditionalObjectStoreV2,
  type S3ConditionalObjectStoreV2Config,
  V2TempStore,
  v2ObjectKeys,
} from '../src/index.js'

const runMinio = process.env.RUN_MINIO_STORE_TESTS === 'true'
const bucket = `databench-v2-minio-${randomUUID()}`

interface RecordedPut {
  readonly client: string
  readonly input: Readonly<PutObjectCommandInput>
  status: number | undefined
}

describe.runIf(runMinio)('V2 Store against real MinIO', () => {
  const clients: S3Client[] = []
  const recordedPuts: RecordedPut[] = []
  let admin: S3Client
  let bucketCreated = false
  let temporaryParent: string

  beforeAll(async () => {
    temporaryParent = await mkdtemp(join(tmpdir(), 'databench-v2-minio-'))
    admin = createS3Client()
    clients.push(admin)
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    bucketCreated = true
  })

  afterAll(async () => {
    if (bucketCreated) {
      await deleteAllObjects(admin, bucket)
      await admin.send(new DeleteBucketCommand({ Bucket: bucket }))
    }
    for (const client of clients) client.destroy()
    if (temporaryParent) {
      await rm(temporaryParent, { force: true, recursive: true })
    }
  })

  test('native S3 conditional create keeps the first payload and maps the collision to 412', async () => {
    const client = createRecordingClient('native-adapter', recordedPuts)
    clients.push(client)
    const adapter = createAdapter(client)
    const key = `objects/v2/integration/${randomUUID()}`
    const firstPayload = Buffer.from('first-payload')
    const secondPayload = Buffer.from('other-payload')

    await expect(
      adapter.conditionalCreate({
        key,
        contentType: 'application/octet-stream',
        contentLength: firstPayload.byteLength,
        body: () => Readable.from([firstPayload]),
      }),
    ).resolves.toEqual({ status: 'created' })
    await expect(
      adapter.conditionalCreate({
        key,
        contentType: 'application/octet-stream',
        contentLength: secondPayload.byteLength,
        body: () => Readable.from([secondPayload]),
      }),
    ).resolves.toMatchObject({ status: 'already_exists' })

    const puts = recordedPuts.filter((put) => put.client === 'native-adapter')
    expect(puts).toHaveLength(2)
    expect(puts.map((put) => put.status)).toEqual([200, 412])
    expect(puts.every((put) => put.input.IfNoneMatch === '*')).toBe(true)

    const destination = new CollectingWritable()
    await expect(adapter.download({ key, destination })).resolves.toBe('downloaded')
    expect(destination.bytes()).toEqual(firstPayload)
  })

  test('two independent V2 Stores concurrently commit and read the same immutable dataset', async () => {
    const firstClient = createRecordingClient('store-one', recordedPuts)
    const secondClient = createRecordingClient('store-two', recordedPuts)
    clients.push(firstClient, secondClient)
    const first = new FileBackedV2Store({
      objectStore: createAdapter(firstClient),
      tempRoot: join(temporaryParent, 'store-one'),
      safetyMarginBytes: 0,
      prepareConcurrency: 1,
      readConcurrency: 1,
    })
    const second = new FileBackedV2Store({
      objectStore: createAdapter(secondClient),
      tempRoot: join(temporaryParent, 'store-two'),
      safetyMarginBytes: 0,
      prepareConcurrency: 1,
      readConcurrency: 1,
    })
    const dataset = makeDataset()
    const [firstPrepared, secondPrepared] = await Promise.all([
      first.prepare(dataset),
      second.prepare(dataset),
    ])

    try {
      expect(firstPrepared.identity).toEqual(secondPrepared.identity)
      expect(firstPrepared.manifest).toEqual(secondPrepared.manifest)

      const [firstManifest, secondManifest] = await Promise.all([
        first.commit(firstPrepared),
        second.commit(secondPrepared),
      ])
      expect(firstManifest).toEqual(secondManifest)

      const [firstRead, secondRead] = await Promise.all([
        first.read(firstPrepared.identity),
        second.read(secondPrepared.identity),
      ])
      expect(firstRead.identity).toEqual(dataset.identity)
      expect(secondRead.identity).toEqual(dataset.identity)
      expect(recordJson(firstRead)).toEqual(recordJson(dataset))
      expect(recordJson(secondRead)).toEqual(recordJson(dataset))

      const keys = v2ObjectKeys(firstPrepared.identity)
      const v2Puts = recordedPuts.filter(
        (put) => put.client === 'store-one' || put.client === 'store-two',
      )
      expect(v2Puts.length).toBeGreaterThanOrEqual(4)
      expect(v2Puts.every((put) => put.input.IfNoneMatch === '*')).toBe(true)
      expect(v2Puts.filter((put) => put.input.Key === keys.artifact).length).toBeGreaterThanOrEqual(
        2,
      )
      expect(v2Puts.filter((put) => put.input.Key === keys.manifest).length).toBeGreaterThanOrEqual(
        2,
      )
      expect(v2Puts.every((put) => put.input.Key?.startsWith('objects/v2/'))).toBe(true)
    } finally {
      await Promise.allSettled([first.discard(firstPrepared), second.discard(secondPrepared)])
    }
  })

  test('two Model Artifact imports race without replacing immutable archive bytes', async () => {
    const firstClient = createRecordingClient('artifact-one', recordedPuts)
    const secondClient = createRecordingClient('artifact-two', recordedPuts)
    clients.push(firstClient, secondClient)
    const firstAdapter = createAdapter(firstClient)
    const secondAdapter = createAdapter(secondClient)
    const first = new ModelArtifactStoreV1({
      objectStore: firstAdapter,
      tempStore: new V2TempStore({
        tempRoot: join(temporaryParent, 'artifact-one'),
        safetyMarginBytes: 0,
      }),
      signedUrlTtlMs: 60_000,
      maxBytes: 1024 * 1024,
    })
    const second = new ModelArtifactStoreV1({
      objectStore: secondAdapter,
      tempStore: new V2TempStore({
        tempRoot: join(temporaryParent, 'artifact-two'),
        safetyMarginBytes: 0,
      }),
      signedUrlTtlMs: 60_000,
      maxBytes: 1024 * 1024,
    })
    const firstImportId = randomUUID()
    const secondImportId = randomUUID()
    const [firstTarget, secondTarget] = await Promise.all([
      first.createStagingTarget(firstImportId),
      second.createStagingTarget(secondImportId),
    ])
    const archive = Buffer.from('same deterministic model artifact archive')
    const identity = {
      archiveDigest: artifactDigest(archive),
      archiveSizeBytes: archive.byteLength,
    }
    await Promise.all([
      admin.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: firstTarget.key,
          Body: archive,
          ContentLength: archive.byteLength,
          ContentType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        }),
      ),
      admin.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: secondTarget.key,
          Body: archive,
          ContentLength: archive.byteLength,
          ContentType: MODEL_ARTIFACT_ARCHIVE_MEDIA_TYPE,
        }),
      ),
    ])

    const publications = await Promise.all([
      first.finalizeStaging(firstImportId, identity),
      second.finalizeStaging(secondImportId, identity),
    ])
    expect(publications[0]?.objectKey).toBe(publications[1]?.objectKey)
    expect(publications.filter((publication) => publication.created)).toHaveLength(1)
    expect(publications.filter((publication) => !publication.created)).toHaveLength(1)

    const destination = new CollectingWritable()
    await expect(
      firstAdapter.download({ key: publications[0]?.objectKey ?? '', destination }),
    ).resolves.toBe('downloaded')
    expect(destination.bytes()).toEqual(archive)
    const artifactPuts = recordedPuts.filter(
      (put) =>
        (put.client === 'artifact-one' || put.client === 'artifact-two') &&
        put.input.Key?.startsWith('objects/v2/model-artifact-v1/') === true,
    )
    expect(artifactPuts).toHaveLength(2)
    expect(artifactPuts.every((put) => put.input.IfNoneMatch === '*')).toBe(true)
    expect(artifactPuts.map((put) => put.status).sort()).toEqual([200, 412])
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

function createAdapter(client: S3Client): S3ConditionalObjectStoreV2 {
  return new S3ConditionalObjectStoreV2({ ...s3Config(), client })
}

function createRecordingClient(name: string, target: RecordedPut[]): S3Client {
  const client = createS3Client()
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName !== 'PutObjectCommand') {
        return await next(args)
      }
      const recorded: RecordedPut = {
        client: name,
        input: Object.freeze({ ...(args.input as PutObjectCommandInput) }),
        status: undefined,
      }
      target.push(recorded)
      try {
        const result = await next(args)
        recorded.status = httpStatus(result.output)
        return result
      } catch (error) {
        recorded.status = httpStatus(error)
        throw error
      }
    },
    {
      name: `recordV2ConditionalPuts${randomUUID().replaceAll('-', '')}`,
      step: 'initialize',
    },
  )
  return client
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const metadata = (value as { readonly $metadata?: { readonly httpStatusCode?: unknown } })
    .$metadata
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined
}

function createS3Client(): S3Client {
  const config = s3Config()
  return new S3Client({
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 1,
    region: config.region,
  })
}

function s3Config(): S3ConditionalObjectStoreV2Config {
  return {
    bucket,
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
    forcePathStyle: true,
  }
}

function makeDataset(): V2Dataset {
  return V2Dataset.fromRecords([
    {
      schema_version: '2.0.0',
      id: `rec_${'a'.repeat(64)}`,
      contents: [],
      candidates: [],
      preference_relations: [],
      tools: [],
      verification: null,
      source: null,
      lang: null,
      lineage: null,
      tags: ['minio-integration'],
      extra: { fixture: 'real-minio-concurrent-commit' },
    },
  ])
}

function recordJson(dataset: V2Dataset): string[] {
  return [...dataset.records()].map((revision) => revision.record_json)
}

function artifactDigest(bytes: Uint8Array): string {
  const hasher = createArtifactHasher()
  hasher.update(bytes)
  return hasher.digestHex()
}

async function deleteAllObjects(client: S3Client, bucketName: string): Promise<void> {
  let continuationToken: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
      }),
    )
    const objects = (page.Contents ?? [])
      .map((entry) => entry.Key)
      .filter((key): key is string => key !== undefined)
      .map((Key) => ({ Key }))
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: objects, Quiet: true },
        }),
      )
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken !== undefined)
}
