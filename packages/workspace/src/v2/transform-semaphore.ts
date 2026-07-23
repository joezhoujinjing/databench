import { CapacityExceededError } from '@databench/schema'

export const DEFAULT_V2_TRANSFORM_CONCURRENCY = 2
export const DEFAULT_V2_TRANSFORM_MAX_PENDING = 64

export interface V2TransformSemaphoreOptions {
  readonly maxConcurrentRuns?: number
  readonly maxPendingRuns?: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface PendingRun<T> {
  readonly operation: (signal: AbortSignal) => Promise<T>
  readonly controller: AbortController
  readonly deferred: Deferred<T>
  readonly callerSignal: AbortSignal | undefined
  phase: 'queued' | 'running' | 'settled'
  publicSettled: boolean
}

/**
 * Process-local admission boundary for transform execution.
 *
 * A running operation keeps its slot until its underlying Promise settles,
 * even when the caller has already aborted and stopped waiting. Queued aborts
 * are removed from the physical queue immediately.
 */
export class V2TransformSemaphore {
  readonly #maxConcurrentRuns: number
  readonly #maxPendingRuns: number
  readonly #queue: PendingRun<unknown>[] = []
  #activeRuns = 0

  constructor(options: V2TransformSemaphoreOptions = {}) {
    this.#maxConcurrentRuns = positiveSafeInteger(
      'maxConcurrentRuns',
      options.maxConcurrentRuns ?? DEFAULT_V2_TRANSFORM_CONCURRENCY,
    )
    this.#maxPendingRuns = positiveSafeInteger(
      'maxPendingRuns',
      options.maxPendingRuns ?? DEFAULT_V2_TRANSFORM_MAX_PENDING,
    )
  }

  get activeRuns(): number {
    return this.#activeRuns
  }

  get pendingRuns(): number {
    return this.#queue.length
  }

  run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (typeof operation !== 'function') {
      throw new TypeError('V2 transform operation must be a function')
    }
    signal?.throwIfAborted()
    if (this.#activeRuns >= this.#maxConcurrentRuns && this.#queue.length >= this.#maxPendingRuns) {
      throw new CapacityExceededError('V2 transform pending run queue is full', {
        resource: 'v2_transform_pending_runs',
        limit: this.#maxPendingRuns,
        actual: this.#queue.length + 1,
      })
    }

    const deferred = createDeferred<T>()
    const entry: PendingRun<T> = {
      operation,
      controller: new AbortController(),
      deferred,
      callerSignal: signal,
      phase: 'queued',
      publicSettled: false,
    }
    const onAbort = (): void => {
      if (entry.phase === 'settled') return
      const reason = signal?.reason ?? abortError('V2 transform run was aborted')
      entry.controller.abort(reason)
      if (entry.phase === 'queued') {
        const index = this.#queue.indexOf(entry as PendingRun<unknown>)
        if (index >= 0) this.#queue.splice(index, 1)
        entry.phase = 'settled'
      }
      if (!entry.publicSettled) {
        entry.publicSettled = true
        deferred.reject(reason)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.#queue.push(entry as PendingRun<unknown>)
    this.#pump()

    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    void deferred.promise.then(cleanup, cleanup)
    return deferred.promise
  }

  #pump(): void {
    while (this.#activeRuns < this.#maxConcurrentRuns) {
      const entry = this.#queue.shift()
      if (!entry) return
      if (entry.phase !== 'queued') continue
      entry.phase = 'running'
      this.#activeRuns += 1
      void this.#execute(entry).finally(() => {
        this.#activeRuns -= 1
        this.#pump()
      })
    }
  }

  async #execute(entry: PendingRun<unknown>): Promise<void> {
    try {
      entry.controller.signal.throwIfAborted()
      const result = await entry.operation(entry.controller.signal)
      entry.controller.signal.throwIfAborted()
      if (!entry.publicSettled) {
        entry.publicSettled = true
        entry.deferred.resolve(result)
      }
    } catch (error) {
      if (!entry.publicSettled) {
        entry.publicSettled = true
        entry.deferred.reject(error)
      }
    } finally {
      entry.phase = 'settled'
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (!resolvePromise || !rejectPromise) {
    throw new Error('Failed to initialize V2 transform deferred Promise')
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}
