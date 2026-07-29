import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import fixture from '../../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import type { ExportPlanV2 } from '../../api/types.js'
import { hasSemanticChanges } from '../../components/export/FidelityReview.js'
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

  test('accepts EvalScope normalized options, config hints, and semantic fidelity review', () => {
    const plan: ExportPlanV2 = {
      ...fixture.export_plan,
      export_fidelity_profile: 'databench-export-fidelity-1',
      converter: 'evalscope-general-qa',
      converter_version: '1.0.0',
      normalized_options: { target_source: 'none' },
      suggested_filename: 'databench.jsonl',
      config_hints: {
        evalscope: {
          benchmark: 'general_qa',
          subset: 'databench',
          total_records: 1,
          output_count: 1,
          excluded_records: 0,
          excluded_by_reason: {},
        },
      },
      fidelity: {
        preserved: ['/contents'],
        changes: [
          {
            path: '',
            action: 'dropped',
            impact: 'semantic',
            reason: 'reference_omitted_requires_judge',
          },
        ],
      },
    }

    expect(hasSemanticChanges(plan)).toBe(true)
    expect(plan.normalized_options).toEqual({ target_source: 'none' })
    expect(plan.config_hints).toHaveProperty('evalscope.benchmark', 'general_qa')
  })
})
