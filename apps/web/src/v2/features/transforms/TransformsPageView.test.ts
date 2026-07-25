import { describe, expect, test } from 'vitest'
import {
  createOrderedInputs,
  formatParamsExample,
  hasTransformParams,
  parseJsonObject,
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
})
