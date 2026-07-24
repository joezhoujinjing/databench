import { describe, expect, test } from 'vitest'
import { moveItem, parseJsonObject } from './TransformsPageView.js'

describe('V2 transform form helpers', () => {
  test('preserves and explicitly changes ordered inputs', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['a', 'b'])
  })

  test('accepts only JSON objects and leaves schema validation to the server', () => {
    expect(parseJsonObject('{"n":1}')).toEqual({ ok: true, value: { n: 1 } })
    expect(parseJsonObject('[]')).toEqual({ ok: false, reason: 'not_object' })
    expect(parseJsonObject('{')).toMatchObject({ ok: false, reason: 'invalid_json' })
  })
})
