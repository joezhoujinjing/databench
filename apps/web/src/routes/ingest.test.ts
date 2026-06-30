import { describe, expect, test } from 'vitest'
import { parseSamplesJson } from './ingest.js'

describe('ingest page helpers', () => {
  test('requires pasted JSON samples to be an array', () => {
    expect(parseSamplesJson('{"kind":"sft"}')).toEqual({ ok: false, reason: 'not_array' })
    expect(parseSamplesJson('[{"kind":"sft"}]')).toEqual({
      ok: true,
      samples: [{ kind: 'sft' }],
    })
  })

  test('surfaces JSON parser errors', () => {
    const result = parseSamplesJson('[')

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'invalid_json' })
  })
})
