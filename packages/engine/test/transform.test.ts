import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { defineTransform } from '../src/index.js'

describe('Transform', () => {
  test('rejects params for paramless transforms with sorted keys', () => {
    const transform = defineTransform({ name: 'dedup', version: '1' }, () => null)

    expect(() => transform.buildParams({ z: true, a: true })).toThrow(
      "transform \"dedup\" takes no params but got: ['a', 'z']",
    )
    expect(transform.buildParams()).toEqual({ params: null, paramsDict: {} })
    expect(transform.toString()).toBe('Transform(name="dedup", version="1")')
  })

  test('zod params include defaults in the canonical params dict', () => {
    const transform = defineTransform(
      {
        name: 'sample_n',
        params: z.object({
          n: z.number().int(),
          seed: z.number().int().default(0),
        }),
      },
      () => null,
    )

    expect(transform.version).toBe('1')
    expect(transform.buildParams({ n: 3 })).toEqual({
      params: { n: 3, seed: 0 },
      paramsDict: { n: 3, seed: 0 },
    })
  })
})
