import { describe, expect, test } from 'vitest'
import { RetirementObjectService, type RetirementObjectStore } from '../src/object-store.js'
import type { ObjectMetadata } from '../src/types.js'

const legacyVersion = 'ab'.repeat(32)
const v2Version = 'cd'.repeat(32)

class MemoryObjectStore implements RetirementObjectStore {
  readonly provider = 's3' as const
  readonly bucket = 'test-bucket'
  readonly objects = new Map<string, ObjectMetadata>()
  readonly deleted: string[] = []

  constructor(objects: readonly ObjectMetadata[]) {
    for (const object of objects) this.objects.set(object.key, object)
  }

  async list(prefix: string): Promise<readonly ObjectMetadata[]> {
    return [...this.objects.values()].filter((object) => object.key.startsWith(prefix))
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.deleted.push(key)
      this.objects.delete(key)
    }
  }
}

describe('retirement object service', () => {
  test('classifies exact v1, protected v2, and unrecognized keys separately', async () => {
    const store = new MemoryObjectStore([
      { key: `objects/ab/${legacyVersion}.parquet`, size: 10, etag: 'a' },
      { key: `objects/ab/${legacyVersion}.manifest.json`, size: 2, etag: 'b' },
      {
        key: `objects/v2/record-json-v1/cd/${v2Version}/${v2Version}.parquet`,
        size: 20,
        etag: 'v2',
      },
      { key: 'objects/not-a-legacy-key', size: 1, etag: null },
    ])
    const plan = await new RetirementObjectService(store).scanV1()
    expect(plan.target_count).toBe(2)
    expect(plan.protected_v2_object_count).toBe(1)
    expect(plan.unrecognized_legacy_prefix_objects.map((object) => object.key)).toEqual([
      'objects/not-a-legacy-key',
    ])
  })

  test('requires the exact digest and never deletes a protected v2 key', async () => {
    const v2Key = `objects/v2/record-json-v1/cd/${v2Version}/${v2Version}.parquet`
    const store = new MemoryObjectStore([
      { key: `objects/ab/${legacyVersion}.parquet`, size: 10, etag: 'a' },
      { key: `objects/ab/${legacyVersion}.manifest.json`, size: 2, etag: 'b' },
      { key: v2Key, size: 20, etag: 'v2' },
    ])
    const service = new RetirementObjectService(store)
    const plan = await service.scanV1()
    await expect(service.deleteV1(plan, '0'.repeat(64))).rejects.toThrow(/confirmation digest/)
    expect(store.deleted).toEqual([])

    await expect(service.deleteV1(plan, plan.digest)).resolves.toBe(2)
    expect(store.deleted).toHaveLength(2)
    expect(store.deleted).not.toContain(v2Key)
    expect(store.objects.has(v2Key)).toBe(true)
  })

  test('fails closed when the target listing drifts after preflight', async () => {
    const store = new MemoryObjectStore([
      { key: `objects/ab/${legacyVersion}.parquet`, size: 10, etag: 'a' },
    ])
    const service = new RetirementObjectService(store)
    const plan = await service.scanV1()
    store.objects.set(`objects/ab/${legacyVersion}.manifest.json`, {
      key: `objects/ab/${legacyVersion}.manifest.json`,
      size: 2,
      etag: 'b',
    })
    await expect(service.deleteV1(plan, plan.digest)).rejects.toThrow(/drifted/)
    expect(store.deleted).toEqual([])
  })
})
