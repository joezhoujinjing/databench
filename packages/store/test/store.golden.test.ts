import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Dataset, toParquetBytes } from '@databench/engine'
import { NotFoundError } from '@databench/schema'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createStore, type OssStoreConfig, storeObjectKeys } from '../src/index.js'

// The object store is Aliyun OSS; there is no local emulator (ali-oss speaks the
// OSS protocol, not S3, so MinIO can't stand in). This integration test runs
// only when real OSS credentials are provided, and skips otherwise (CI, most
// dev machines). Unit/e2e coverage of the workspace uses an in-memory store.
const hasOssCreds = Boolean(
  process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET && process.env.OSS_BUCKET,
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

describe('store object keys', () => {
  test('shards objects by the first two hash characters', () => {
    const version = '0021f72168030ba1d57110c96a10a4cc7f2194d37dfe1a131726785c2e215b44'
    expect(storeObjectKeys(version)).toEqual({
      parquet: `objects/00/${version}.parquet`,
      manifest: `objects/00/${version}.manifest.json`,
    })
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
