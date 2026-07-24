import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import fixture from '../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import { readRefConflictDetail } from './RefConflictRecovery.js'

describe('V2 ref conflict recovery', () => {
  test('accepts only the typed ref conflict detail used by the three recovery actions', () => {
    const error = new ApiError({
      code: 'ref_conflict',
      detail: fixture.ref_conflict.error.detail,
      message: 'moved',
      status: 409,
    })
    expect(readRefConflictDetail(error)).toEqual(fixture.ref_conflict.error.detail)
    expect(readRefConflictDetail(new Error('not a conflict'))).toBeNull()
  })
})
