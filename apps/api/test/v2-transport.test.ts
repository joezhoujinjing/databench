import { describe, expect, test } from 'vitest'
import { readBoundedRequestBodyV2 } from '../src/routes/v2/transport.js'

describe('V2 bounded JSON transport', () => {
  test('aborts a pending body read and cancels the source', async () => {
    const controller = new AbortController()
    const reason = new DOMException('caller disconnected', 'AbortError')
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Leave the read pending until cancellation.
      },
      cancel(value) {
        cancelReason = value
      },
    })
    const request = streamingRequest(body, controller.signal)
    const reading = readBoundedRequestBodyV2(request, 128)

    await Promise.resolve()
    controller.abort(reason)

    await expect(reading).rejects.toBe(reason)
    expect(cancelReason).toBe(reason)
  })

  test('cancels a declared-overlimit body before rejecting it', async () => {
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel(value) {
        cancelReason = value
      },
    })
    const request = new Request('http://localhost/v2/transforms/subset/run', {
      method: 'POST',
      headers: { 'content-length': '129' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    await expect(readBoundedRequestBodyV2(request, 128)).rejects.toMatchObject({
      code: 'resource_limit',
      detail: { resource: 'request_bytes', limit: 128, actual: 129 },
    })
    expect(cancelReason).toMatchObject({ code: 'resource_limit' })
  })

  test('preserves an oversized decimal Content-Length without numeric precision loss', async () => {
    const body = new ReadableStream<Uint8Array>()
    const request = new Request('http://localhost/v2/transforms/subset/run', {
      method: 'POST',
      headers: { 'content-length': '18446744073709551615' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    await expect(readBoundedRequestBodyV2(request, 128)).rejects.toMatchObject({
      code: 'resource_limit',
      detail: {
        resource: 'request_bytes',
        limit: 128,
        actual: '18446744073709551615',
      },
    })
  })
})

function streamingRequest(body: ReadableStream<Uint8Array>, signal: AbortSignal): Request {
  return new Request('http://localhost/v2/transforms/subset/run', {
    method: 'POST',
    body,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}
