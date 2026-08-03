import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import fixture from '../../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import type { ConverterDescriptorV2, ExportPlanV2 } from '../../api/types.js'
import { hasSemanticChanges } from '../../components/export/FidelityReview.js'
import { converterOptionsMode, fidelityPlanFromError, formatPreviewText } from './ExportPageView.js'

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

describe('V2 export preview controls', () => {
  const descriptor = (input: Partial<ConverterDescriptorV2>): ConverterDescriptorV2 => ({
    export_fidelity_profile: 'databench-export-fidelity-1',
    media_type: 'application/x-ndjson',
    name: 'canonical-jsonl',
    options_schema: {},
    task_views: ['canonical'],
    version: '1.0.0',
    ...input,
  })

  test('uses the converter schema for empty options and the EvalScope answer source', () => {
    expect(
      converterOptionsMode(
        descriptor({
          options_schema: { type: 'object', properties: {}, additionalProperties: false },
        }),
      ),
    ).toEqual({ kind: 'none' })
    expect(
      converterOptionsMode(
        descriptor({
          name: 'evalscope-general-qa',
          options_schema: {
            type: 'object',
            properties: {
              target_source: {
                type: 'string',
                enum: ['selected-candidate', 'verification-ground-truth', 'none'],
              },
            },
            additionalProperties: false,
          },
        }),
      ),
    ).toEqual({ kind: 'evalscope-target-source' })
    expect(
      converterOptionsMode(
        descriptor({ options_schema: { type: 'object', properties: { future: {} } } }),
      ),
    ).toEqual({ kind: 'json' })
  })

  test('pretty prints complete real JSON and leaves truncated text untouched', () => {
    expect(formatPreviewText('{"messages":[]}', false)).toBe('{\n  "messages": []\n}')
    expect(formatPreviewText('{"messages":', true)).toBe('{"messages":')
  })
})
