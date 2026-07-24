import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import fixture from '../../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import { fidelityPlanFromError } from './ExportPageView.js'

describe('V2 fidelity drift', () => {
  test('extracts the replacement plan only from a fidelity error', () => {
    const error = new ApiError({
      code: 'fidelity_error',
      detail: { plan: fixture.export_plan, reason: 'fidelity_digest_mismatch' },
      message: 'changed',
      status: 422,
    })
    expect(fidelityPlanFromError(error)).toEqual(fixture.export_plan)
    expect(
      fidelityPlanFromError(
        new ApiError({ code: 'validation_error', message: 'bad', status: 422 }),
      ),
    ).toBeNull()
  })
})
