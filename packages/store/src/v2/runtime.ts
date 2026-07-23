export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw abortError(signal.reason)
}

export function abortError(reason?: unknown): Error & { code: 'ABORT_ERR' } {
  const error = new Error('The operation was aborted', { cause: reason }) as Error & {
    code: 'ABORT_ERR'
  }
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

interface Waiter {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export class SemaphoreV2 {
  readonly #limit: number
  readonly #queue: Waiter[] = []
  #active = 0

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Semaphore limit must be a positive safe integer')
    }
    this.#limit = limit
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    if (this.#active < this.#limit) {
      this.#active += 1
      return this.#releaseOnce()
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              onAbort: () => {
                const index = this.#queue.indexOf(waiter)
                if (index >= 0) this.#queue.splice(index, 1)
                reject(abortError(signal.reason))
              },
            }),
      }
      if (waiter.onAbort) signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.#queue.push(waiter)
    })
  }

  #releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#queue.shift()
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
        next.resolve(this.#releaseOnce())
        return
      }
      this.#active -= 1
    }
  }
}
