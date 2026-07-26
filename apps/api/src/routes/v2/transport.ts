import {
  BadInputError,
  parseRawJsonBodyV2,
  type RawJsonLimitsV2,
  ResourceLimitError,
} from '@databench/schema'
import type { Context } from 'hono'
import type { z } from 'zod'
import type { ApiEnv } from '../../context.js'

export {
  contentDispositionAttachment as contentDispositionAttachmentV2,
  streamAsyncIterable as streamAsyncIterableV2,
} from '../../response.js'

export async function readRawJsonRequestV2<T>(
  context: Context<ApiEnv>,
  schema: z.ZodType<T>,
  limits: RawJsonLimitsV2,
): Promise<T> {
  const bytes = await readBoundedRequestBodyV2(context.req.raw, limits.maxBytes)
  return parseRawJsonBodyV2(bytes, schema, limits)
}

export function assertJsonContentTypeV2(request: Request): void {
  const contentType = request.headers.get('content-type')
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new BadInputError('V2 JSON request requires Content-Type application/json')
  }
}

export async function readBoundedRequestBodyV2(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('V2 request byte limit must be a non-negative safe integer')
  }

  const body = request.body
  const declaredLength = parseContentLength(request.headers.get('content-length'))
  if (
    declaredLength !== null &&
    (typeof declaredLength === 'string' || declaredLength > maxBytes)
  ) {
    const error = requestBytesExceeded(maxBytes, declaredLength)
    if (body !== null) {
      void body.cancel(error).catch(() => undefined)
    }
    throw error
  }

  if (body === null) return new Uint8Array()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    const reason =
      request.signal.reason ?? new DOMException('V2 request body was aborted', 'AbortError')
    rejectAbort?.(reason)
    cancelReaderBestEffort(reader, reason)
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (request.signal.aborted) onAbort()
    while (true) {
      request.signal.throwIfAborted()
      const result = await Promise.race([reader.read(), aborted])
      request.signal.throwIfAborted()
      if (result.done) break
      total = checkedRequestSize(total, result.value.byteLength)
      if (total > maxBytes) {
        const error = requestBytesExceeded(maxBytes, total)
        cancelReaderBestEffort(reader, error)
        throw error
      }
      chunks.push(result.value)
    }
  } catch (error) {
    cancelReaderBestEffort(reader, error)
    throw error
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // A hostile stream may still be settling its cancelled pending read.
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined)
  } catch {
    // Preserve the primary request failure.
  }
}

function checkedRequestSize(current: number, next: number): number {
  const total = current + next
  if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY
  return total
}

function parseContentLength(value: string | null): number | string | null {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : value
}

function requestBytesExceeded(limit: number, actual: number | string): ResourceLimitError {
  return new ResourceLimitError('V2 request exceeds the configured byte limit', {
    resource: 'request_bytes',
    limit,
    actual,
  })
}
