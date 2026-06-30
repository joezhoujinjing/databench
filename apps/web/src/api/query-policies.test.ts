import { describe, expect, test } from 'vitest'
import { ApiError } from './errors.js'
import { isNotDeployed, retryOptionalFeature } from './query-policies.js'

describe('query policies', () => {
  test('does not retry optional modules that are not deployed', () => {
    const missing = new ApiError({ code: 'not_found', message: 'missing', status: 404 })
    const notImplemented = new ApiError({
      code: 'not_implemented',
      message: 'missing',
      status: 501,
    })
    const transient = new ApiError({ code: 'internal_error', message: 'boom', status: 500 })

    expect(isNotDeployed(missing)).toBe(true)
    expect(isNotDeployed(notImplemented)).toBe(true)
    expect(retryOptionalFeature(0, missing)).toBe(false)
    expect(retryOptionalFeature(0, transient)).toBe(true)
    expect(retryOptionalFeature(1, transient)).toBe(false)
  })
})
