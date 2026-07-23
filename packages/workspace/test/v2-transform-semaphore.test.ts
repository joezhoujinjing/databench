import { describe, expect, test, vi } from 'vitest'
import { V2TransformSemaphore } from '../src/v2/transform-semaphore.js'

describe('V2TransformSemaphore', () => {
  test('serializes execution at the configured concurrency', async () => {
    const semaphore = new V2TransformSemaphore({ maxConcurrentRuns: 1, maxPendingRuns: 2 })
    const firstGate = deferred<void>()
    const events: string[] = []
    const first = semaphore.run(async () => {
      events.push('first:start')
      await firstGate.promise
      events.push('first:end')
      return 1
    })
    const second = semaphore.run(async () => {
      events.push('second:start')
      return 2
    })
    await nextTurn()
    expect(semaphore.activeRuns).toBe(1)
    expect(semaphore.pendingRuns).toBe(1)
    expect(events).toEqual(['first:start'])

    firstGate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    expect(semaphore.activeRuns).toBe(0)
    expect(semaphore.pendingRuns).toBe(0)
  })

  test('physically removes an aborted queued run and frees queue capacity', async () => {
    const semaphore = new V2TransformSemaphore({ maxConcurrentRuns: 1, maxPendingRuns: 1 })
    const firstGate = deferred<void>()
    const first = semaphore.run(async () => await firstGate.promise)
    const queuedController = new AbortController()
    const queued = semaphore.run(async () => 'never', queuedController.signal)
    await nextTurn()
    expect(semaphore.pendingRuns).toBe(1)
    expect(() => semaphore.run(async () => 'overflow')).toThrowError(/queue is full/)

    queuedController.abort(new DOMException('cancel queued', 'AbortError'))
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(semaphore.pendingRuns).toBe(0)
    const replacement = semaphore.run(async () => 'replacement')
    expect(semaphore.pendingRuns).toBe(1)

    firstGate.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(replacement).resolves.toBe('replacement')
  })

  test('keeps a non-cooperative aborted run in its slot until it settles', async () => {
    const semaphore = new V2TransformSemaphore({ maxConcurrentRuns: 1, maxPendingRuns: 1 })
    const underlying = deferred<void>()
    const controller = new AbortController()
    const operation = vi.fn(async () => {
      await underlying.promise
      return 'late'
    })
    const running = semaphore.run(operation, controller.signal)
    const second = vi.fn(async () => 'second')
    const queued = semaphore.run(second)
    await nextTurn()

    controller.abort(new DOMException('cancel running', 'AbortError'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(semaphore.activeRuns).toBe(1)
    expect(semaphore.pendingRuns).toBe(1)
    expect(second).not.toHaveBeenCalled()

    underlying.resolve()
    await expect(queued).resolves.toBe('second')
    expect(semaphore.activeRuns).toBe(0)
    expect(semaphore.pendingRuns).toBe(0)
  })
})

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  let rejectPromise: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (!resolvePromise || !rejectPromise) throw new Error('failed to create test deferred')
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
