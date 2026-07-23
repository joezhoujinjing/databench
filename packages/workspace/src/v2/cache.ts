import { DEFAULT_V2_DATASET_LIMITS, V2Dataset, type V2DatasetLimits } from '@databench/engine'
import { CapacityExceededError, IntegrityError } from '@databench/schema'

export const V2_DATASET_CACHE_RECORD_OVERHEAD_BYTES = 256
const DEFAULT_V2_CACHE_LOAD_CONCURRENCY = 2
export const DEFAULT_V2_CACHE_MAX_PENDING_LOADS = 64
const DIGEST_HEX = /^[0-9a-f]{64}$/
const LAYOUT_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/

export const DEFAULT_V2_DATASET_CACHE_MAX_ENTRY_WEIGHT =
  v2DatasetCacheRequiredWeight(DEFAULT_V2_DATASET_LIMITS)

export interface V2DatasetCacheKey {
  readonly dataset_version: string
  readonly layout_version: string
  readonly artifact_digest: string
}

export interface V2DatasetCacheOptions {
  readonly capacityBytes: number
  readonly maxConcurrentLoads?: number
  readonly maxPendingLoads?: number
  readonly maxEntryWeight?: number
}

export interface V2DatasetCacheAcquireOptions {
  readonly signal?: AbortSignal
  /**
   * Internal orchestration mode: reject for cancellation only after an already
   * running shared loader settles, so an outer resource gate cannot release
   * early while the loader still consumes memory or I/O.
   */
  readonly settleOnAbort?: boolean
}

export interface V2DatasetLease {
  readonly key: Readonly<V2DatasetCacheKey>
  readonly dataset: V2Dataset
  readonly weight: number
  release(): void
}

export type V2DatasetLoader = (signal: AbortSignal) => Promise<V2Dataset>

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface LoadingEntry {
  readonly kind: 'loading'
  readonly serializedKey: string
  readonly key: Readonly<V2DatasetCacheKey>
  readonly loader: V2DatasetLoader
  readonly controller: AbortController
  readonly deferred: Deferred<ReadyEntry>
  waiters: number
  phase: 'loading' | 'ready' | 'failed'
  ready: ReadyEntry | undefined
  reservationBytes: number
  started: boolean
  queued: boolean
}

interface UncachedEntry {
  readonly kind: 'uncached'
  readonly operation: (signal: AbortSignal) => Promise<unknown>
  readonly controller: AbortController
  readonly deferred: Deferred<unknown>
  readonly reservationWeight: number
  phase: 'queued' | 'running' | 'settled'
  reservationBytes: number
  queued: boolean
}

interface ReadyEntry {
  readonly kind: 'ready'
  readonly serializedKey: string
  readonly key: Readonly<V2DatasetCacheKey>
  readonly dataset: V2Dataset
  readonly weight: number
  pins: number
  lastAccess: number
  evictOnRelease: boolean
  retained: boolean
}

type CacheEntry = LoadingEntry | ReadyEntry
type LoadQueueEntry = LoadingEntry | UncachedEntry

/**
 * Process-local cache for fully verified immutable V2 datasets.
 *
 * A cold load first occupies a global load slot and then reserves the configured
 * worst-case entry weight. This keeps decoded datasets and in-flight decodes in
 * the same byte budget instead of discovering overcommit only after decoding.
 */
export class V2DatasetCache {
  readonly #capacityBytes: number
  readonly #maxConcurrentLoads: number
  readonly #maxPendingLoads: number
  readonly #maxEntryWeight: number
  readonly #entries = new Map<string, CacheEntry>()
  readonly #loadQueue: LoadQueueEntry[] = []
  #activeLoads = 0
  #queuedLoads = 0
  #usedBytes = 0
  #reservedBytes = 0
  #clock = 0

  constructor(options: V2DatasetCacheOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('V2 dataset cache options must be an object')
    }
    this.#capacityBytes = nonNegativeSafeInteger('capacityBytes', options.capacityBytes)
    this.#maxConcurrentLoads = positiveSafeInteger(
      'maxConcurrentLoads',
      options.maxConcurrentLoads ?? DEFAULT_V2_CACHE_LOAD_CONCURRENCY,
    )
    this.#maxPendingLoads = positiveSafeInteger(
      'maxPendingLoads',
      options.maxPendingLoads ?? DEFAULT_V2_CACHE_MAX_PENDING_LOADS,
    )
    this.#maxEntryWeight = nonNegativeSafeInteger(
      'maxEntryWeight',
      options.maxEntryWeight ?? DEFAULT_V2_DATASET_CACHE_MAX_ENTRY_WEIGHT,
    )
  }

  get capacityBytes(): number {
    return this.#capacityBytes
  }

  get maxEntryWeight(): number {
    return this.#maxEntryWeight
  }

  get usedBytes(): number {
    return this.#usedBytes
  }

  get reservedBytes(): number {
    return this.#reservedBytes
  }

  get entryCount(): number {
    return this.#entries.size
  }

  get activeLoads(): number {
    return this.#activeLoads
  }

  get pendingLoads(): number {
    return this.#queuedLoads
  }

  has(keyInput: V2DatasetCacheKey): boolean {
    const serializedKey = serializeKey(validateKey(keyInput))
    return this.#entries.get(serializedKey)?.kind === 'ready'
  }

  acquire(
    keyInput: V2DatasetCacheKey,
    loader: V2DatasetLoader,
    options: V2DatasetCacheAcquireOptions = {},
  ): Promise<V2DatasetLease> {
    if (typeof loader !== 'function') {
      throw new TypeError('V2 dataset cache loader must be a function')
    }
    const key = validateKey(keyInput)
    const signal = options.signal
    signal?.throwIfAborted()
    const serializedKey = serializeKey(key)
    const existing = this.#entries.get(serializedKey)

    if (existing?.kind === 'ready') {
      existing.pins += 1
      existing.lastAccess = this.#tick()
      return Promise.resolve(this.#lease(existing))
    }
    if (existing?.kind === 'loading') {
      existing.waiters += 1
      return this.#waitForLoading(existing, signal, options.settleOnAbort === true)
    }

    this.#assertQueueCapacity()
    const deferred = createDeferred<ReadyEntry>()
    // The cache owns the load signal. Individual callers only abort their own
    // waiter; the shared load is aborted after the last waiter leaves.
    const loading: LoadingEntry = {
      kind: 'loading',
      serializedKey,
      key,
      loader,
      controller: new AbortController(),
      deferred,
      waiters: 1,
      phase: 'loading',
      ready: undefined,
      reservationBytes: 0,
      started: false,
      queued: false,
    }
    loading.queued = true
    this.#entries.set(serializedKey, loading)
    this.#loadQueue.push(loading)
    this.#queuedLoads += 1
    // A load may outlive all canceled waiters. Keep its rejection handled while
    // the normal waiters still observe the original promise.
    void deferred.promise.catch(() => undefined)
    this.#pumpLoads()
    return this.#waitForLoading(loading, signal, options.settleOnAbort === true)
  }

  /**
   * Runs an uncached cold read (for example audit) under the same load and byte
   * admission gates as cached reads. The operation never creates a cache entry.
   */
  runUncached<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: V2DatasetCacheAcquireOptions = {},
  ): Promise<T> {
    if (typeof operation !== 'function') {
      throw new TypeError('V2 uncached cache operation must be a function')
    }
    const signal = options.signal
    signal?.throwIfAborted()
    this.#assertQueueCapacity()
    const deferred = createDeferred<unknown>()
    const controller = new AbortController()
    const entry: UncachedEntry = {
      kind: 'uncached',
      operation,
      controller,
      deferred,
      reservationWeight: this.#maxEntryWeight,
      phase: 'queued',
      reservationBytes: 0,
      queued: false,
    }
    const onAbort = (): void => {
      if (entry.phase === 'settled') return
      const error = signal?.reason ?? abortError('V2 uncached cache operation was aborted')
      controller.abort(error)
      if (entry.phase === 'queued') {
        this.#removeQueued(entry)
        entry.phase = 'settled'
        deferred.reject(error)
      } else {
        // The caller can stop waiting immediately, but the executor keeps its
        // slot and byte reservation until the underlying operation settles.
        deferred.reject(error)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    } else {
      entry.queued = true
      this.#loadQueue.push(entry)
      this.#queuedLoads += 1
      this.#pumpLoads()
    }
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    void deferred.promise.then(cleanup, cleanup)
    return deferred.promise as Promise<T>
  }

  /**
   * Evicts an exact immutable layout. A pinned entry is detached immediately so
   * no new caller can acquire it, but its bytes remain charged until the final
   * lease releases.
   */
  evict(keyInput: V2DatasetCacheKey): boolean {
    const key = validateKey(keyInput)
    const serializedKey = serializeKey(key)
    const entry = this.#entries.get(serializedKey)
    if (!entry) return false

    if (entry.kind === 'loading') {
      this.#entries.delete(serializedKey)
      const error = abortError('V2 dataset cache load was explicitly evicted')
      entry.controller.abort(error)
      this.#failBeforeStart(entry, error)
      return true
    }
    if (entry.pins > 0) {
      this.#entries.delete(serializedKey)
      entry.evictOnRelease = true
      return false
    }
    this.#removeReady(entry)
    return true
  }

  #waitForLoading(
    entry: LoadingEntry,
    signal: AbortSignal | undefined,
    settleOnAbort: boolean,
  ): Promise<V2DatasetLease> {
    return new Promise<V2DatasetLease>((resolve, reject) => {
      let waiting = true
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        if (!waiting) return
        waiting = false
        cleanup()
        const reason = signal?.reason ?? abortError('V2 dataset cache waiter was aborted')
        const waitForLoader = settleOnAbort && entry.started && entry.phase === 'loading'
        this.#releaseLoadingWaiter(entry, reason)
        if (waitForLoader) {
          void entry.deferred.promise.then(
            () => reject(reason),
            () => reject(reason),
          )
        } else {
          reject(reason)
        }
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      entry.deferred.promise.then(
        (ready) => {
          if (!waiting) return
          waiting = false
          cleanup()
          // Admission reserved one pin for every live loading waiter.
          resolve(this.#lease(ready))
        },
        (error: unknown) => {
          if (!waiting) return
          waiting = false
          cleanup()
          reject(error)
        },
      )
    })
  }

  #releaseLoadingWaiter(entry: LoadingEntry, reason: unknown): void {
    if (entry.phase === 'loading') {
      if (entry.waiters > 0) entry.waiters -= 1
      if (entry.waiters === 0) {
        if (this.#entries.get(entry.serializedKey) === entry) {
          this.#entries.delete(entry.serializedKey)
        }
        const error = reason ?? abortError('All V2 dataset cache waiters were aborted')
        entry.controller.abort(error)
        this.#failBeforeStart(entry, error)
      }
      return
    }
    if (entry.phase === 'ready' && entry.ready) {
      this.#releaseReadyPin(entry.ready)
    }
  }

  #lease(entry: ReadyEntry): V2DatasetLease {
    let released = false
    return Object.freeze({
      key: entry.key,
      dataset: entry.dataset,
      weight: entry.weight,
      release: () => {
        if (released) return
        released = true
        this.#releaseReadyPin(entry)
      },
    })
  }

  #releaseReadyPin(entry: ReadyEntry): void {
    if (entry.pins <= 0) return
    entry.pins -= 1
    if (entry.pins === 0 && entry.evictOnRelease) {
      this.#removeReady(entry)
    }
  }

  #pumpLoads(): void {
    while (this.#activeLoads < this.#maxConcurrentLoads) {
      const entry = this.#loadQueue.shift()
      if (!entry) return
      this.#markDequeued(entry)
      if (entry.kind === 'loading') {
        if (entry.phase !== 'loading') continue
        entry.started = true
      } else {
        if (entry.phase !== 'queued') continue
        entry.phase = 'running'
      }
      this.#activeLoads += 1
      const execution =
        entry.kind === 'loading' ? this.#executeLoad(entry) : this.#executeUncached(entry)
      void execution.finally(() => {
        this.#activeLoads -= 1
        this.#pumpLoads()
      })
    }
  }

  async #executeLoad(entry: LoadingEntry): Promise<void> {
    try {
      entry.controller.signal.throwIfAborted()
      // Ordering is deliberate: this method is called only after the scheduler
      // has occupied a cold-load slot, and budget is reserved before the loader.
      this.#reserveForLoad(entry)
      const dataset = await entry.loader(entry.controller.signal)
      entry.controller.signal.throwIfAborted()
      if (this.#entries.get(entry.serializedKey) !== entry || entry.waiters === 0) {
        throw abortError('V2 dataset cache load no longer has an active waiter')
      }
      if (!(dataset instanceof V2Dataset)) {
        throw new TypeError('V2 dataset cache loader must resolve to a V2Dataset')
      }
      if (dataset.version !== entry.key.dataset_version) {
        throw new IntegrityError('Loaded V2 dataset does not match the requested cache identity', {
          expected_dataset_version: entry.key.dataset_version,
          actual_dataset_version: dataset.version,
        })
      }

      const weight = v2DatasetCacheWeight(dataset)
      if (weight > entry.reservationBytes) {
        throw new CapacityExceededError(
          'Loaded V2 dataset exceeds its reserved cache entry budget',
          {
            resource: 'v2_dataset_cache_entry_bytes',
            limit: entry.reservationBytes,
            actual: weight,
          },
        )
      }

      this.#releaseReservation(entry)
      const ready: ReadyEntry = {
        kind: 'ready',
        serializedKey: entry.serializedKey,
        key: entry.key,
        dataset,
        weight,
        pins: entry.waiters,
        lastAccess: this.#tick(),
        evictOnRelease: false,
        retained: true,
      }
      this.#usedBytes += weight
      entry.phase = 'ready'
      entry.ready = ready
      this.#entries.set(entry.serializedKey, ready)
      entry.deferred.resolve(ready)
    } catch (error) {
      this.#releaseReservation(entry)
      entry.phase = 'failed'
      if (this.#entries.get(entry.serializedKey) === entry) {
        this.#entries.delete(entry.serializedKey)
      }
      entry.deferred.reject(error)
    }
  }

  async #executeUncached(entry: UncachedEntry): Promise<void> {
    try {
      entry.controller.signal.throwIfAborted()
      this.#reserveBytes(entry, entry.reservationWeight)
      const result = await entry.operation(entry.controller.signal)
      entry.controller.signal.throwIfAborted()
      entry.phase = 'settled'
      entry.deferred.resolve(result)
    } catch (error) {
      entry.phase = 'settled'
      entry.deferred.reject(error)
    } finally {
      this.#releaseReservation(entry)
    }
  }

  #reserveForLoad(entry: LoadingEntry): void {
    this.#reserveBytes(entry, this.#maxEntryWeight)
  }

  #failBeforeStart(entry: LoadingEntry, error: unknown): void {
    if (entry.started || entry.phase !== 'loading') return
    this.#removeQueued(entry)
    entry.phase = 'failed'
    entry.deferred.reject(error)
  }

  #assertQueueCapacity(): void {
    if (
      this.#activeLoads >= this.#maxConcurrentLoads &&
      this.#queuedLoads >= this.#maxPendingLoads
    ) {
      throw new CapacityExceededError('V2 dataset cache pending load queue is full', {
        resource: 'v2_dataset_cache_pending_loads',
        limit: this.#maxPendingLoads,
        actual: this.#queuedLoads + 1,
      })
    }
  }

  #markDequeued(entry: LoadQueueEntry): void {
    if (!entry.queued) return
    entry.queued = false
    this.#queuedLoads -= 1
  }

  #removeQueued(entry: LoadQueueEntry): void {
    this.#markDequeued(entry)
    const index = this.#loadQueue.indexOf(entry)
    if (index >= 0) this.#loadQueue.splice(index, 1)
  }

  #reserveBytes(entry: { reservationBytes: number }, requested: number): void {
    this.#evictUntilAvailable(requested)
    entry.reservationBytes = requested
    this.#reservedBytes += requested
  }

  #releaseReservation(entry: { reservationBytes: number }): void {
    if (entry.reservationBytes === 0) return
    this.#reservedBytes -= entry.reservationBytes
    entry.reservationBytes = 0
  }

  #evictUntilAvailable(requested: number): void {
    while (requested > this.#capacityBytes - this.#usedBytes - this.#reservedBytes) {
      const victim = this.#leastRecentlyUsedUnpinned()
      if (!victim) {
        throw new CapacityExceededError('V2 dataset cache has insufficient unpinned capacity', {
          resource: 'v2_dataset_cache_bytes',
          limit: this.#capacityBytes,
          actual: checkedTotal(this.#usedBytes, this.#reservedBytes, requested),
        })
      }
      this.#removeReady(victim)
    }
  }

  #leastRecentlyUsedUnpinned(): ReadyEntry | undefined {
    let oldest: ReadyEntry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.kind !== 'ready' || entry.pins > 0) continue
      if (!oldest || entry.lastAccess < oldest.lastAccess) oldest = entry
    }
    return oldest
  }

  #removeReady(entry: ReadyEntry): void {
    if (!entry.retained) return
    if (this.#entries.get(entry.serializedKey) === entry) {
      this.#entries.delete(entry.serializedKey)
    }
    entry.retained = false
    this.#usedBytes -= entry.weight
  }

  #tick(): number {
    this.#clock += 1
    return this.#clock
  }
}

export function v2DatasetCacheWeight(dataset: V2Dataset): number {
  if (!(dataset instanceof V2Dataset)) {
    throw new TypeError('V2 dataset cache weight requires a V2Dataset')
  }
  const recordOverhead = checkedMultiply(
    dataset.identity.num_records,
    V2_DATASET_CACHE_RECORD_OVERHEAD_BYTES,
  )
  const weight = checkedTotal(dataset.canonicalBytes, recordOverhead)
  if (typeof weight === 'string') {
    throw new CapacityExceededError('V2 dataset cache weight exceeds the safe integer range', {
      resource: 'v2_dataset_cache_entry_bytes',
      limit: Number.MAX_SAFE_INTEGER,
      actual: weight,
    })
  }
  return weight
}

export function v2DatasetCacheRequiredWeight(limits: V2DatasetLimits): number {
  if (limits === null || typeof limits !== 'object') {
    throw new TypeError('V2 dataset cache limits must be an object')
  }
  const canonicalBytes = nonNegativeSafeInteger('max_canonical_bytes', limits.max_canonical_bytes)
  const recordOverhead = checkedMultiply(
    nonNegativeSafeInteger('max_records', limits.max_records),
    V2_DATASET_CACHE_RECORD_OVERHEAD_BYTES,
  )
  const required = checkedTotal(canonicalBytes, recordOverhead)
  if (typeof required === 'string') {
    throw new CapacityExceededError(
      'V2 dataset cache limit weight exceeds the safe integer range',
      {
        resource: 'v2_dataset_cache_entry_bytes',
        limit: Number.MAX_SAFE_INTEGER,
        actual: required,
      },
    )
  }
  return required
}

function validateKey(input: V2DatasetCacheKey): Readonly<V2DatasetCacheKey> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('V2 dataset cache key must be an object')
  }
  if (!DIGEST_HEX.test(input.dataset_version)) {
    throw new TypeError('V2 dataset cache dataset_version must be 64 lowercase hex characters')
  }
  if (!LAYOUT_VERSION.test(input.layout_version)) {
    throw new TypeError('V2 dataset cache layout_version is invalid')
  }
  if (!DIGEST_HEX.test(input.artifact_digest)) {
    throw new TypeError('V2 dataset cache artifact_digest must be 64 lowercase hex characters')
  }
  return Object.freeze({
    dataset_version: input.dataset_version,
    layout_version: input.layout_version,
    artifact_digest: input.artifact_digest,
  })
}

function serializeKey(key: Readonly<V2DatasetCacheKey>): string {
  return `${key.dataset_version}\0${key.layout_version}\0${key.artifact_digest}`
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (!resolvePromise || !rejectPromise) {
    throw new Error('Failed to initialize V2 dataset cache deferred promise')
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function checkedMultiply(left: number, right: number): number {
  nonNegativeSafeInteger('cache weight operand', left)
  nonNegativeSafeInteger('cache weight operand', right)
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new CapacityExceededError('V2 dataset cache weight exceeds the safe integer range', {
      resource: 'v2_dataset_cache_entry_bytes',
      limit: Number.MAX_SAFE_INTEGER,
    })
  }
  return left * right
}

function checkedTotal(...values: readonly number[]): number | string {
  let total = 0n
  for (const value of values) {
    nonNegativeSafeInteger('cache byte count', value)
    total += BigInt(value)
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString()
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}
