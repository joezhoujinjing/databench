import { V2Dataset } from '@databench/engine'
import { CapacityExceededError, type PostTrainingRecordV2 } from '@databench/schema'
import { describe, expect, test, vi } from 'vitest'
import { V2DatasetCache, type V2DatasetCacheKey, v2DatasetCacheWeight } from '../src/v2/cache.js'

describe('V2DatasetCache', () => {
  test('coalesces an exact layout load and gives every waiter an idempotent pinned lease', async () => {
    const dataset = makeDataset('1', 'coalesced')
    const weight = v2DatasetCacheWeight(dataset)
    expect(weight).toBe(dataset.canonicalBytes + 256 * dataset.identity.num_records)
    const reservation = weight + 1_024
    const cache = createCache(reservation, reservation)
    const load = deferred<V2Dataset>()
    const firstLoader = vi.fn(async () => await load.promise)
    const secondLoader = vi.fn(async () => dataset)
    const identity = key(dataset, 'a', 'record-json-v1')

    const firstPromise = cache.acquire(identity, firstLoader)
    const secondPromise = cache.acquire(identity, secondLoader)
    await eventually(() => expect(firstLoader).toHaveBeenCalledTimes(1))
    expect(secondLoader).not.toHaveBeenCalled()
    expect(cache.reservedBytes).toBe(reservation)

    load.resolve(dataset)
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first.dataset).toBe(dataset)
    expect(second.dataset).toBe(dataset)
    expect(cache.usedBytes).toBe(weight)
    expect(cache.reservedBytes).toBe(0)

    expect(cache.evict(identity)).toBe(false)
    first.release()
    first.release()
    expect(cache.usedBytes).toBe(weight)
    second.release()
    expect(cache.usedBytes).toBe(0)
    expect(cache.entryCount).toBe(0)
  })

  test('uses dataset version, layout version, and artifact digest as the complete key', async () => {
    const dataset = makeDataset('2', 'identity')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight * 3, weight, 3)
    const loader = vi.fn(async () => dataset)
    const identities = [
      key(dataset, 'a', 'record-json-v1'),
      key(dataset, 'b', 'record-json-v1'),
      key(dataset, 'a', 'record-json-v2'),
    ]

    const leases = await Promise.all(identities.map((identity) => cache.acquire(identity, loader)))
    expect(loader).toHaveBeenCalledTimes(3)
    expect(cache.entryCount).toBe(3)
    for (const lease of leases) lease.release()
  })

  test('removes a failed promise so a retry can start a fresh loader', async () => {
    const dataset = makeDataset('3', 'retry')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight)
    const identity = key(dataset)
    const failure = new Error('cold load failed')
    const failedLoader = vi.fn(async () => {
      throw failure
    })

    await expect(cache.acquire(identity, failedLoader)).rejects.toBe(failure)
    expect(cache.entryCount).toBe(0)
    expect(cache.usedBytes).toBe(0)
    expect(cache.reservedBytes).toBe(0)

    const retryLoader = vi.fn(async () => dataset)
    const lease = await cache.acquire(identity, retryLoader)
    expect(retryLoader).toHaveBeenCalledTimes(1)
    lease.release()
  })

  test('takes a load slot before reserving and does not invoke a queued loader early', async () => {
    const firstDataset = makeDataset('4', 'first')
    const secondDataset = makeDataset('5', 'second')
    const maxWeight = Math.max(
      v2DatasetCacheWeight(firstDataset),
      v2DatasetCacheWeight(secondDataset),
    )
    const cache = createCache(maxWeight * 2, maxWeight, 1)
    const firstLoad = deferred<V2Dataset>()
    const firstLoader = vi.fn(async () => await firstLoad.promise)
    const secondLoader = vi.fn(async () => secondDataset)

    const firstPromise = cache.acquire(key(firstDataset), firstLoader)
    const secondPromise = cache.acquire(key(secondDataset), secondLoader)
    await eventually(() => expect(firstLoader).toHaveBeenCalledTimes(1))
    expect(cache.activeLoads).toBe(1)
    expect(cache.reservedBytes).toBe(maxWeight)
    expect(secondLoader).not.toHaveBeenCalled()

    firstLoad.resolve(firstDataset)
    const first = await firstPromise
    await eventually(() => expect(secondLoader).toHaveBeenCalledTimes(1))
    const second = await secondPromise
    first.release()
    second.release()
  })

  test('fails reservation before invoking a loader when the entry upper bound cannot fit', async () => {
    const dataset = makeDataset('6', 'reservation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight - 1, weight)
    const loader = vi.fn(async () => dataset)

    await expect(cache.acquire(key(dataset), loader)).rejects.toBeInstanceOf(CapacityExceededError)
    expect(loader).not.toHaveBeenCalled()
    expect(cache.activeLoads).toBe(0)
    expect(cache.reservedBytes).toBe(0)
  })

  test('charges concurrent loading reservations against the same byte budget', async () => {
    const firstDataset = makeDataset('7', 'first reservation')
    const secondDataset = makeDataset('8', 'second reservation')
    const maxWeight = Math.max(
      v2DatasetCacheWeight(firstDataset),
      v2DatasetCacheWeight(secondDataset),
    )
    const cache = createCache(maxWeight, maxWeight, 2)
    const firstLoad = deferred<V2Dataset>()
    const firstLoader = vi.fn(async () => await firstLoad.promise)
    const secondLoader = vi.fn(async () => secondDataset)

    const firstPromise = cache.acquire(key(firstDataset), firstLoader)
    await eventually(() => expect(firstLoader).toHaveBeenCalledTimes(1))
    expect(cache.reservedBytes).toBe(maxWeight)

    await expect(cache.acquire(key(secondDataset), secondLoader)).rejects.toBeInstanceOf(
      CapacityExceededError,
    )
    expect(secondLoader).not.toHaveBeenCalled()
    expect(cache.reservedBytes).toBe(maxWeight)

    firstLoad.resolve(firstDataset)
    const first = await firstPromise
    first.release()
  })

  test('evicts the least-recently-used unpinned entry and never evicts a pinned entry', async () => {
    const firstDataset = makeDataset('9', 'same-size')
    const secondDataset = makeDataset('a', 'same-size')
    const thirdDataset = makeDataset('b', 'same-size')
    const weight = v2DatasetCacheWeight(firstDataset)
    expect(v2DatasetCacheWeight(secondDataset)).toBe(weight)
    expect(v2DatasetCacheWeight(thirdDataset)).toBe(weight)
    const cache = createCache(weight * 2, weight, 1)
    const firstKey = key(firstDataset)
    const secondKey = key(secondDataset)
    const thirdKey = key(thirdDataset)

    const first = await cache.acquire(firstKey, async () => firstDataset)
    first.release()
    const second = await cache.acquire(secondKey, async () => secondDataset)
    second.release()

    const touchedFirst = await cache.acquire(firstKey, async () => firstDataset)
    touchedFirst.release()
    const third = await cache.acquire(thirdKey, async () => thirdDataset)
    third.release()
    expect(cache.has(firstKey)).toBe(true)
    expect(cache.has(secondKey)).toBe(false)
    expect(cache.has(thirdKey)).toBe(true)

    const pinnedFirst = await cache.acquire(firstKey, async () => firstDataset)
    const secondReload = vi.fn(async () => secondDataset)
    const reloadedSecond = await cache.acquire(secondKey, secondReload)
    expect(secondReload).toHaveBeenCalledTimes(1)
    expect(cache.has(firstKey)).toBe(true)
    pinnedFirst.release()
    reloadedSecond.release()
  })

  test('returns a typed capacity error rather than evicting the only pinned entry', async () => {
    const firstDataset = makeDataset('c', 'pinned')
    const secondDataset = makeDataset('d', 'second')
    const maxWeight = Math.max(
      v2DatasetCacheWeight(firstDataset),
      v2DatasetCacheWeight(secondDataset),
    )
    const cache = createCache(maxWeight, maxWeight)
    const first = await cache.acquire(key(firstDataset), async () => firstDataset)
    const secondLoader = vi.fn(async () => secondDataset)

    await expect(cache.acquire(key(secondDataset), secondLoader)).rejects.toBeInstanceOf(
      CapacityExceededError,
    )
    expect(secondLoader).not.toHaveBeenCalled()
    expect(cache.has(key(firstDataset))).toBe(true)
    first.release()
  })

  test('aborting one waiter does not abort its coalesced peer', async () => {
    const dataset = makeDataset('e', 'one cancellation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight)
    const load = deferred<V2Dataset>()
    let sharedSignal: AbortSignal | undefined
    const loader = vi.fn(async (signal: AbortSignal) => {
      sharedSignal = signal
      return await load.promise
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = cache.acquire(key(dataset), loader, { signal: firstController.signal })
    const second = cache.acquire(key(dataset), loader, { signal: secondController.signal })
    await eventually(() => expect(loader).toHaveBeenCalledTimes(1))
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)

    load.resolve(dataset)
    const secondLease = await second
    expect(secondLease.dataset).toBe(dataset)
    secondLease.release()
  })

  test('aborts the shared loader after all coalesced waiters cancel', async () => {
    const dataset = makeDataset('f', 'all cancellation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight)
    let sharedSignal: AbortSignal | undefined
    const loader = vi.fn(
      async (signal: AbortSignal) =>
        await new Promise<V2Dataset>((_resolve, reject) => {
          sharedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = cache.acquire(key(dataset), loader, { signal: firstController.signal })
    const second = cache.acquire(key(dataset), loader, { signal: secondController.signal })
    await eventually(() => expect(loader).toHaveBeenCalledTimes(1))
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)

    secondController.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(true)
    await eventually(() => {
      expect(cache.entryCount).toBe(0)
      expect(cache.reservedBytes).toBe(0)
      expect(cache.activeLoads).toBe(0)
    })
  })

  test('keeps cached-load admission charged until a non-cooperative loader settles', async () => {
    const dataset = makeDataset('8', 'non-cooperative cancellation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight, 1)
    const controller = new AbortController()
    const load = deferred<V2Dataset>()
    const pending = cache.acquire(key(dataset), async () => await load.promise, {
      signal: controller.signal,
    })
    await eventually(() => expect(cache.activeLoads).toBe(1))

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cache.activeLoads).toBe(1)
    expect(cache.reservedBytes).toBe(weight)

    load.resolve(dataset)
    await eventually(() => {
      expect(cache.activeLoads).toBe(0)
      expect(cache.reservedBytes).toBe(0)
      expect(cache.entryCount).toBe(0)
    })
  })

  test('can keep an outer executor waiting until an aborted loader really settles', async () => {
    const dataset = makeDataset('9', 'settling cancellation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight, 1)
    const controller = new AbortController()
    const load = deferred<V2Dataset>()
    const pending = cache.acquire(key(dataset), async () => await load.promise, {
      signal: controller.signal,
      settleOnAbort: true,
    })
    let publiclySettled = false
    void pending.catch(() => {
      publiclySettled = true
    })
    await eventually(() => expect(cache.activeLoads).toBe(1))

    controller.abort(new DOMException('cancel settling waiter', 'AbortError'))
    await Promise.resolve()
    expect(publiclySettled).toBe(false)
    expect(cache.activeLoads).toBe(1)
    expect(cache.reservedBytes).toBe(weight)

    load.resolve(dataset)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => {
      expect(cache.activeLoads).toBe(0)
      expect(cache.reservedBytes).toBe(0)
      expect(cache.entryCount).toBe(0)
    })
  })

  test('explicit eviction rejects a queued cold load without invoking its loader', async () => {
    const firstDataset = makeDataset('0', 'active')
    const queuedDataset = makeDataset('1', 'queued')
    const maxWeight = Math.max(
      v2DatasetCacheWeight(firstDataset),
      v2DatasetCacheWeight(queuedDataset),
    )
    const cache = createCache(maxWeight * 2, maxWeight, 1)
    const activeLoad = deferred<V2Dataset>()
    const activeLoader = vi.fn(async () => await activeLoad.promise)
    const queuedLoader = vi.fn(async () => queuedDataset)
    const activePromise = cache.acquire(key(firstDataset), activeLoader)
    const queuedKey = key(queuedDataset)
    const queuedPromise = cache.acquire(queuedKey, queuedLoader)
    await eventually(() => expect(activeLoader).toHaveBeenCalledTimes(1))

    expect(cache.evict(queuedKey)).toBe(true)
    await expect(queuedPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(queuedLoader).not.toHaveBeenCalled()

    activeLoad.resolve(firstDataset)
    const active = await activePromise
    active.release()
  })

  test('bounds distinct pending cold loads while preserving exact-key coalescing', async () => {
    const activeDataset = makeDataset('5', 'active queue bound')
    const queuedDataset = makeDataset('6', 'queued once')
    const rejectedDataset = makeDataset('7', 'queue overflow')
    const maxWeight = Math.max(
      v2DatasetCacheWeight(activeDataset),
      v2DatasetCacheWeight(queuedDataset),
      v2DatasetCacheWeight(rejectedDataset),
    )
    const cache = createCache(maxWeight * 2, maxWeight, 1, 1)
    const activeLoad = deferred<V2Dataset>()
    const active = cache.acquire(key(activeDataset), async () => await activeLoad.promise)
    const queuedLoader = vi.fn(async () => queuedDataset)
    const queued = cache.acquire(key(queuedDataset), queuedLoader)
    const coalesced = cache.acquire(key(queuedDataset), async () => queuedDataset)

    expect(cache.pendingLoads).toBe(1)
    expect(() => cache.acquire(key(rejectedDataset), async () => rejectedDataset)).toThrow(
      CapacityExceededError,
    )
    expect(() => cache.runUncached(async () => 'overflow')).toThrow(CapacityExceededError)

    activeLoad.resolve(activeDataset)
    const activeLease = await active
    const [queuedLease, coalescedLease] = await Promise.all([queued, coalesced])
    activeLease.release()
    queuedLease.release()
    coalescedLease.release()
  })

  test('runs uncached audit work through the same cold-load slot without caching its result', async () => {
    const dataset = makeDataset('2', 'cached before audit')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight * 2, weight, 1)
    const coldLoad = deferred<V2Dataset>()
    const cachedLoader = vi.fn(async () => await coldLoad.promise)
    const auditOperation = vi.fn(async () => 'audited')

    const cachedPromise = cache.acquire(key(dataset), cachedLoader)
    const auditPromise = cache.runUncached(auditOperation)
    await eventually(() => expect(cachedLoader).toHaveBeenCalledTimes(1))
    expect(auditOperation).not.toHaveBeenCalled()

    coldLoad.resolve(dataset)
    const cached = await cachedPromise
    await eventually(() => expect(auditOperation).toHaveBeenCalledTimes(1))
    await expect(auditPromise).resolves.toBe('audited')
    expect(cache.reservedBytes).toBe(0)
    expect(cache.entryCount).toBe(1)
    cached.release()
  })

  test('uncached audit reservation cannot bypass a pinned cache entry or the total budget', async () => {
    const dataset = makeDataset('3', 'pinned during audit')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight, 1)
    const cached = await cache.acquire(key(dataset), async () => dataset)
    const auditOperation = vi.fn(async () => 'audited')

    await expect(cache.runUncached(auditOperation)).rejects.toBeInstanceOf(CapacityExceededError)
    expect(auditOperation).not.toHaveBeenCalled()
    expect(cache.usedBytes).toBe(weight)
    expect(cache.reservedBytes).toBe(0)

    cached.release()
    await expect(cache.runUncached(auditOperation)).resolves.toBe('audited')
    expect(auditOperation).toHaveBeenCalledTimes(1)
    expect(cache.usedBytes).toBe(0)
    expect(cache.reservedBytes).toBe(0)
  })

  test('uncached cancellation holds admission until the underlying operation settles', async () => {
    const dataset = makeDataset('4', 'audit cancellation')
    const weight = v2DatasetCacheWeight(dataset)
    const cache = createCache(weight, weight, 1)
    const controller = new AbortController()
    let operationSignal: AbortSignal | undefined
    const operationDone = deferred<string>()
    const auditOperation = vi.fn(async (signal: AbortSignal) => {
      operationSignal = signal
      return await operationDone.promise
    })

    const audit = cache.runUncached(auditOperation, { signal: controller.signal })
    await eventually(() => expect(auditOperation).toHaveBeenCalledTimes(1))
    expect(cache.activeLoads).toBe(1)
    expect(cache.reservedBytes).toBe(weight)

    controller.abort()
    await expect(audit).rejects.toMatchObject({ name: 'AbortError' })
    expect(operationSignal?.aborted).toBe(true)
    expect(cache.activeLoads).toBe(1)
    expect(cache.reservedBytes).toBe(weight)

    operationDone.resolve('ignored after cancellation')
    await eventually(() => {
      expect(cache.activeLoads).toBe(0)
      expect(cache.reservedBytes).toBe(0)
    })
  })
})

function createCache(
  capacityBytes: number,
  maxEntryWeight: number,
  maxConcurrentLoads = 2,
  maxPendingLoads = 64,
): V2DatasetCache {
  return new V2DatasetCache({
    capacityBytes,
    maxEntryWeight,
    maxConcurrentLoads,
    maxPendingLoads,
  })
}

function key(
  dataset: V2Dataset,
  artifactDigit = dataset.version[0] ?? '0',
  layoutVersion = 'record-json-v1',
): V2DatasetCacheKey {
  return {
    dataset_version: dataset.version,
    layout_version: layoutVersion,
    artifact_digest: artifactDigit.repeat(64),
  }
}

function makeDataset(idDigit: string, text: string): V2Dataset {
  return V2Dataset.fromRecords([makeRecord(idDigit, text)])
}

function makeRecord(idDigit: string, text: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${idDigit.repeat(64)}`,
    system_instruction: null,
    contents: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text,
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: null,
      },
    ],
    candidates: [],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

interface TestDeferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): TestDeferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) throw new Error('deferred did not initialize')
  return { promise, resolve: resolvePromise }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      if (attempt === 49) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
}
