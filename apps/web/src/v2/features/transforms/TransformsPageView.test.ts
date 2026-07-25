import { describe, expect, test } from 'vitest'
import {
  createOrderedInputs,
  formatParamsExample,
  hasTransformParams,
  parseJsonObject,
  transformJobProgressPercent,
} from './TransformsPageView.js'

describe('V2 transform form helpers', () => {
  test('creates fixed ordered inputs from registry roles', () => {
    expect(createOrderedInputs(['base', 'patch'])).toEqual([
      { id: 'base-1', role: 'base', value: '' },
      { id: 'patch-2', role: 'patch', value: '' },
    ])
  })

  test('formats registry examples and distinguishes empty parameter schemas', () => {
    expect(formatParamsExample({ count: 100, seed: 42 })).toBe(
      '{\n  "count": 100,\n  "seed": 42\n}',
    )
    expect(hasTransformParams({ properties: {} })).toBe(false)
    expect(hasTransformParams({ properties: { count: { type: 'integer' } } })).toBe(true)
  })

  test('accepts only JSON objects and leaves schema validation to the server', () => {
    expect(parseJsonObject('{"n":1}')).toEqual({ ok: true, value: { n: 1 } })
    expect(parseJsonObject('[]')).toEqual({ ok: false, reason: 'not_object' })
    expect(parseJsonObject('{')).toMatchObject({ ok: false, reason: 'invalid_json' })
  })

  test('derives bounded progress only when Worker reports a total', () => {
    const job = {
      id: `job_${'a'.repeat(64)}`,
      cache_key: 'a'.repeat(64),
      operation: { name: 'basic-clean', version: '1' },
      input_dataset_versions: ['b'.repeat(64)] as [string],
      status: 'running' as const,
      attempt: 1,
      progress: { phase: 'processing', completed_units: 7, total_units: 10 },
      input_count: 10,
      output_count: null,
      output_dataset_version: null,
      cache_hit: false,
      error: null,
      created_at: '2026-07-25T12:00:00.000Z',
      started_at: '2026-07-25T12:00:01.000Z',
      finished_at: null,
    }
    expect(transformJobProgressPercent(job)).toBe(70)
    expect(
      transformJobProgressPercent({ ...job, progress: { ...job.progress, total_units: null } }),
    ).toBeNull()
  })
})
