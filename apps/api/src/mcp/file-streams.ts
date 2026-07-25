import { ServiceUnavailableError } from '@databench/schema'

export class McpFileOperationDeadline {
  readonly #controller = new AbortController()
  readonly #idleTimeoutMs: number
  readonly #totalTimer: NodeJS.Timeout
  #idleTimer: NodeJS.Timeout | undefined
  #timedOut = false
  #closed = false
  readonly signal: AbortSignal

  constructor(requestSignal: AbortSignal, idleTimeoutMs: number, totalTimeoutMs: number) {
    this.#idleTimeoutMs = idleTimeoutMs
    this.signal = AbortSignal.any([requestSignal, this.#controller.signal])
    this.#totalTimer = setTimeout(() => {
      this.#timedOut = true
      this.#controller.abort(new DOMException('MCP file operation total timeout', 'TimeoutError'))
    }, totalTimeoutMs)
    this.#totalTimer.unref()
    this.touch()
  }

  touch(): void {
    if (this.#closed) return
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      this.#timedOut = true
      this.#controller.abort(new DOMException('MCP file operation idle timeout', 'TimeoutError'))
    }, this.#idleTimeoutMs)
    this.#idleTimer.unref()
  }

  stopIdle(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
  }

  abort(reason: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#totalTimer)
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
  }

  mapError(error: unknown): unknown {
    if (!this.#timedOut) return error
    return new ServiceUnavailableError('MCP file operation timed out', {
      dependency: 'unknown',
      retryable: true,
    })
  }
}

export async function* streamMcpRequestBody(
  request: Request,
  deadline: McpFileOperationDeadline,
): AsyncIterableIterator<Uint8Array> {
  const body = request.body
  if (body === null) {
    deadline.stopIdle()
    return
  }
  const reader = body.getReader()
  let completed = false
  const onAbort = () => {
    const reason =
      deadline.signal.reason ?? new DOMException('MCP file upload was aborted', 'AbortError')
    try {
      void reader.cancel(reason).catch(() => undefined)
    } catch {
      // Preserve the primary abort/timeout reason.
    }
  }
  deadline.signal.addEventListener('abort', onAbort, { once: true })
  try {
    deadline.signal.throwIfAborted()
    while (true) {
      const next = await reader.read()
      deadline.signal.throwIfAborted()
      if (next.done) {
        completed = true
        deadline.stopIdle()
        return
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError('MCP file request body must yield Uint8Array chunks')
      }
      deadline.touch()
      yield next.value
      deadline.signal.throwIfAborted()
    }
  } finally {
    deadline.signal.removeEventListener('abort', onAbort)
    if (!completed) {
      try {
        await reader.cancel(new DOMException('MCP file body consumer stopped', 'AbortError'))
      } catch {
        // Preserve the primary operation result.
      }
    }
    try {
      reader.releaseLock()
    } catch {
      // A cancelled hostile stream may still be settling.
    }
  }
}

export async function* finalizeMcpResponseStream(
  source: AsyncIterable<Uint8Array>,
  deadline: McpFileOperationDeadline,
  finish: () => void,
): AsyncIterableIterator<Uint8Array> {
  try {
    deadline.signal.throwIfAborted()
    for await (const chunk of source) {
      deadline.signal.throwIfAborted()
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('MCP file response source must yield Uint8Array chunks')
      }
      deadline.touch()
      yield chunk
      deadline.signal.throwIfAborted()
    }
  } catch (error) {
    throw deadline.mapError(error)
  } finally {
    deadline.close()
    finish()
  }
}
