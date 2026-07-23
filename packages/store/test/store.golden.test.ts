import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Dataset, toParquetBytes } from '@databench/engine'
import { NotFoundError } from '@databench/schema'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  createStore,
  type OssStoreConfig,
  type S3StoreConfig,
  storeObjectKeys,
} from '../src/index.js'

// The production object store is Aliyun OSS; local development can explicitly
// select S3/MinIO. Live integration suites are gated so CI/dev machines without
// the matching backend skip them. Unit/e2e coverage of the workspace uses an
// in-memory store.
const hasOssCreds = Boolean(
  process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET && process.env.OSS_BUCKET,
)
const hasS3Backend = Boolean(
  process.env.S3_ENDPOINT || process.env.RUN_MINIO_STORE_TESTS === 'true',
)

function ossConfig(): OssStoreConfig {
  return {
    bucket: process.env.OSS_BUCKET ?? '',
    region: process.env.OSS_REGION ?? 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID ?? '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET ?? '',
    ...(process.env.OSS_ENDPOINT ? { endpoint: process.env.OSS_ENDPOINT } : {}),
  }
}

const s3TestBucket = `databench-test-${randomUUID()}`

function s3Config(): S3StoreConfig {
  return {
    bucket: s3TestBucket,
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
    forcePathStyle: true,
  }
}

describe('store object keys', () => {
  test('shards objects by the first two hash characters', () => {
    const version = '0021f72168030ba1d57110c96a10a4cc7f2194d37dfe1a131726785c2e215b44'
    expect(storeObjectKeys(version)).toEqual({
      parquet: `objects/00/${version}.parquet`,
      manifest: `objects/00/${version}.manifest.json`,
    })
  })
})

describe.runIf(hasS3Backend)('S3Store against MinIO', () => {
  let store: ReturnType<typeof createStore>
  let client: S3Client
  const cleanup = new Set<string>()

  beforeAll(async () => {
    const config = s3Config()
    store = createStore({ ...config, kind: 's3' })
    client = new S3Client({
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
    })
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
  })

  afterEach(async () => {
    await cleanupS3Objects(client, s3TestBucket, cleanup)
  })

  afterAll(async () => {
    await cleanupS3Objects(client, s3TestBucket, cleanup)
    await client.send(new DeleteBucketCommand({ Bucket: s3TestBucket })).catch(() => undefined)
  })

  test('round-trips a dataset and leaves the first manifest untouched on repeated write', async () => {
    const dataset = makeDataset()
    const keys = storeObjectKeys(dataset.version)
    cleanup.add(keys.parquet).add(keys.manifest)

    const version = await store.write(dataset)
    expect(version).toBe(dataset.version)
    expect(await store.exists(version)).toBe(true)

    const roundTrip = await store.read(version)
    expect(roundTrip.manifest).toEqual(dataset.manifest)
    expect(roundTrip.toPolars().toRecords()).toEqual(dataset.toPolars().toRecords())

    const changed = new Dataset(dataset.toPolars(), {
      ...dataset.manifest,
      created_at: '1970-01-01T00:00:00.000Z',
    })
    expect(await store.write(changed)).toBe(version)
    expect((await store.read(version)).manifest.created_at).toBe(dataset.manifest.created_at)
  })

  test('requires both parquet and manifest before a version exists', async () => {
    const dataset = makeDataset()
    const keys = storeObjectKeys(dataset.version)
    cleanup.add(keys.parquet)
    await client.send(
      new PutObjectCommand({
        Body: Buffer.from(toParquetBytes(dataset)),
        Bucket: s3TestBucket,
        ContentType: 'application/vnd.apache.parquet',
        Key: keys.parquet,
      }),
    )

    expect(await store.exists(dataset.version)).toBe(false)
    await expect(store.read(dataset.version)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('ping resolves against the configured bucket', async () => {
    await store.ping?.()
  })
})

const nodeRequire = createRequire(import.meta.url)

interface RawOssClient {
  put(name: string, file: Buffer, options?: { mime?: string }): Promise<unknown>
  delete(name: string): Promise<unknown>
}

describe.runIf(hasOssCreds)('OssStore against a real OSS bucket', () => {
  // Constructed in beforeAll (not the describe body): vitest still runs the body
  // of a skipped suite during collection, and ali-oss's constructor throws on
  // absent credentials — beforeAll only runs when the suite is actually active.
  let store: ReturnType<typeof createStore>
  let raw: RawOssClient
  const cleanup = new Set<string>()

  beforeAll(() => {
    store = createStore(ossConfig())
    const OSS = nodeRequire('ali-oss') as new (options: OssStoreConfig) => RawOssClient
    raw = new OSS(ossConfig())
  })

  afterEach(async () => {
    await Promise.all([...cleanup].map((key) => raw.delete(key).catch(() => undefined)))
    cleanup.clear()
  })

  test('round-trips a dataset and leaves the first manifest untouched on repeated write', async () => {
    const dataset = makeDataset()
    const keys = storeObjectKeys(dataset.version)
    cleanup.add(keys.parquet).add(keys.manifest)

    const version = await store.write(dataset)
    expect(version).toBe(dataset.version)
    expect(await store.exists(version)).toBe(true)

    const roundTrip = await store.read(version)
    expect(roundTrip.manifest).toEqual(dataset.manifest)
    expect(roundTrip.toPolars().toRecords()).toEqual(dataset.toPolars().toRecords())

    const changed = new Dataset(dataset.toPolars(), {
      ...dataset.manifest,
      created_at: '1970-01-01T00:00:00.000Z',
    })
    expect(await store.write(changed)).toBe(version)
    expect((await store.read(version)).manifest.created_at).toBe(dataset.manifest.created_at)
  })

  test('requires both parquet and manifest before a version exists', async () => {
    const dataset = makeDataset()
    const keys = storeObjectKeys(dataset.version)
    cleanup.add(keys.parquet)
    await raw.put(keys.parquet, Buffer.from(toParquetBytes(dataset)), {
      mime: 'application/vnd.apache.parquet',
    })

    expect(await store.exists(dataset.version)).toBe(false)
    await expect(store.read(dataset.version)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('ping resolves against the configured bucket', async () => {
    await store.ping?.()
  })
})

function makeDataset(): Dataset {
  const id = randomUUID()

  return Dataset.fromSamples(
    [
      {
        kind: 'sft',
        source: `store-${id}`,
        messages: [
          { role: 'user', content: `hello ${id}` },
          { role: 'assistant', content: 'stored' },
        ],
      },
    ],
    `store-${id}`,
  )
}

async function cleanupS3Objects(
  client: S3Client | undefined,
  bucket: string,
  cleanup: Set<string>,
): Promise<void> {
  if (!client) {
    return
  }

  await Promise.all(
    [...cleanup].map((key) =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined),
    ),
  )
  cleanup.clear()
}
