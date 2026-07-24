import { describe, expect, test } from 'vitest'
import { ApiError, apiErrorFromBody } from '@/api/errors.js'
import { classifyV2ReadError } from './V2ReadErrorState.js'

describe('V2 read error recovery state', () => {
  test('preserves the diagnostic request ID and distinguishes integrity failures', () => {
    const error = apiErrorFromBody(
      500,
      { error: { code: 'integrity_error', message: 'corrupt' } },
      'request-123',
    )
    expect(error.requestId).toBe('request-123')
    expect(classifyV2ReadError(error)).toBe('integrity')
  })

  test('separates auth, not-found, validation, network and generic failures', () => {
    const error = (status: number) => new ApiError({ code: 'error', message: 'x', status })
    expect(classifyV2ReadError(error(401))).toBe('unauthorized')
    expect(classifyV2ReadError(error(403))).toBe('forbidden')
    expect(classifyV2ReadError(error(404))).toBe('not_found')
    expect(classifyV2ReadError(error(422))).toBe('validation')
    expect(classifyV2ReadError(error(0))).toBe('network')
    expect(classifyV2ReadError(error(503))).toBe('other')
  })
})
