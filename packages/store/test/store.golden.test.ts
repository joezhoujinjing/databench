import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { createStore, storeObjectKeys } from '../src/index.js'

const TEST_BUCKET = `databench-test-${randomUUID()}`
const MINIO_CONFIG = {
  bucket: TEST_BUCKET,
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
  forcePathStyle: true,
}

// Legacy bench store lives in the external Python repo; its path is configurable
// via `DATABENCH_LEGACY_REPO`. The test that reads it is gated on its presence
// (see `test.runIf` below) so CI/other machines skip it instead of ENOENT-ing.
const LEGACY_REPO = process.env.DATABENCH_LEGACY_REPO ?? '/Users/hanlu/Desktop/databench/databench'
const BENCH_STORE = join(LEGACY_REPO, 'bench', 'store')
const BENCH_VERSION = '0021f72168030ba1d57110c96a10a4cc7f2194d37dfe1a131726785c2e215b44'

const client = new S3Client({
  region: MINIO_CONFIG.region,
  endpoint: MINIO_CONFIG.endpoint,
  credentials: {
    accessKeyId: MINIO_CONFIG.accessKeyId,
    secretAccessKey: MINIO_CONFIG.secretAccessKey,
  },
  forcePathStyle: MINIO_CONFIG.forcePathStyle,
})
const store = createStore(MINIO_CONFIG)
const cleanupKeys = new Set<string>()

beforeAll(async () => {
  await client.send(new CreateBucketCommand({ Bucket: MINIO_CONFIG.bucket }))
})

afterEach(async () => {
  await cleanupObjects()
})

afterAll(async () => {
  await cleanupObjects()
  await client.send(new DeleteBucketCommand({ Bucket: MINIO_CONFIG.bucket }))
})

async function cleanupObjects(): Promise<void> {
  await Promise.all(
    [...cleanupKeys].map((key) =>
      client.send(new DeleteObjectCommand({ Bucket: MINIO_CONFIG.bucket, Key: key })),
    ),
  )
  cleanupKeys.clear()
}

describe('store object keys', () => {
  test('matches the legacy bench/store object layout', () => {
    expect(storeObjectKeys(BENCH_VERSION)).toEqual({
      parquet: `objects/00/${BENCH_VERSION}.parquet`,
      manifest: `objects/00/${BENCH_VERSION}.manifest.json`,
    })
  })
})

describe('S3Store against MinIO', () => {
  test('round-trips a dataset and leaves the first manifest untouched on repeated write', async () => {
    const dataset = makeDataset()
    const version = await store.write(dataset)
    rememberVersion(version)

    expect(version).toBe(dataset.version)
    expect(await store.exists(version)).toBe(true)

    const roundTrip = await store.read(version)
    expect(roundTrip.manifest).toEqual(dataset.manifest)
    expect(roundTrip.toPolars().toRecords()).toEqual(dataset.toPolars().toRecords())

    const changedManifest = new Dataset(dataset.toPolars(), {
      ...dataset.manifest,
      created_at: '1970-01-01T00:00:00.000Z',
    })

    expect(await store.write(changedManifest)).toBe(version)
    expect((await store.read(version)).manifest.created_at).toBe(dataset.manifest.created_at)
  })

  test('requires both parquet and manifest before a version exists', async () => {
    const dataset = makeDataset()
    const keys = storeObjectKeys(dataset.version)
    await putObject(keys.parquet, toParquetBytes(dataset), 'application/vnd.apache.parquet')

    expect(await store.exists(dataset.version)).toBe(false)
    await expect(store.read(dataset.version)).rejects.toBeInstanceOf(NotFoundError)
  })

  test.runIf(existsSync(BENCH_STORE))(
    'can read objects laid out like the legacy bench store',
    async () => {
      const keys = storeObjectKeys(BENCH_VERSION)
      const shard = BENCH_VERSION.slice(0, 2)
      await putObject(
        keys.parquet,
        readFileSync(join(BENCH_STORE, 'objects', shard, `${BENCH_VERSION}.parquet`)),
        'application/vnd.apache.parquet',
      )
      await putObject(
        keys.manifest,
        readFileSync(join(BENCH_STORE, 'objects', shard, `${BENCH_VERSION}.manifest.json`)),
        'application/json',
      )

      const dataset = await store.read(BENCH_VERSION)

      expect(dataset.version).toBe(BENCH_VERSION)
      expect(dataset.manifest.version).toBe(BENCH_VERSION)
      expect(dataset.manifest.name).toBe('pref-raw')
      expect(dataset.length).toBe(dataset.manifest.num_rows)
    },
  )
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

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  cleanupKeys.add(key)
  await client.send(
    new PutObjectCommand({
      Bucket: MINIO_CONFIG.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

function rememberVersion(version: string): void {
  const keys = storeObjectKeys(version)
  cleanupKeys.add(keys.parquet)
  cleanupKeys.add(keys.manifest)
}
