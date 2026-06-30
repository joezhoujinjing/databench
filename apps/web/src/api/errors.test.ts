import { describe, expect, test } from 'vitest'
import { ApiError, ensureJsonResponse, networkApiError, responseToApiError } from './errors.js'

describe('ApiError parsing', () => {
  test('parses databench error envelopes', async () => {
    const error = await responseToApiError(
      Response.json(
        { error: { code: 'not_found', detail: [{ msg: 'missing' }], message: 'dataset missing' } },
        { status: 404 },
      ),
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('dataset missing')
    expect(error.detail).toEqual([{ msg: 'missing' }])
  })

  test('keeps legacy FastAPI detail compatibility', async () => {
    const stringDetail = await responseToApiError(
      Response.json({ detail: 'legacy missing' }, { status: 404 }),
    )
    const arrayDetail = await responseToApiError(
      Response.json({ detail: [{ msg: 'field required' }] }, { status: 422 }),
    )

    expect(stringDetail.code).toBe('not_found')
    expect(stringDetail.message).toBe('legacy missing')
    expect(arrayDetail.code).toBe('validation_error')
    expect(arrayDetail.message).toBe('field required')
  })

  test('rejects 2xx non-json responses as not_databench', async () => {
    await expect(
      ensureJsonResponse(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' }, status: 200 }),
      ),
    ).rejects.toMatchObject({
      code: 'not_databench',
      status: 200,
    })
  })

  test('wraps network failures with status 0', () => {
    const error = networkApiError(new Error('offline'))

    expect(error.status).toBe(0)
    expect(error.code).toBe('unreachable')
  })
})
