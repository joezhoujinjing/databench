import { describe, expect, test } from 'vitest'
import { parseJsonObject, parseTransformInputs } from './transforms.js'

describe('transforms page helpers', () => {
  test('parses transform inputs separated by commas or newlines', () => {
    expect(parseTransformInputs('raw, clean\nmix')).toEqual(['raw', 'clean', 'mix'])
  })

  test('requires transform params to be a JSON object', () => {
    expect(parseJsonObject('{}')).toEqual({ ok: true, value: {} })
    expect(parseJsonObject('[]')).toEqual({ ok: false, reason: 'not_object' })
    expect(parseJsonObject('null')).toEqual({ ok: false, reason: 'not_object' })
    expect(parseJsonObject('{')).toMatchObject({ ok: false, reason: 'invalid_json' })
  })
})
