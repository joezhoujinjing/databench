import { describe, expect, test } from 'vitest'
import { parseRecipeJson } from './recipes.js'

describe('recipe page helpers', () => {
  test('requires recipe JSON to be an object', () => {
    expect(parseRecipeJson('{"name":"mix","sources":[]}')).toEqual({
      ok: true,
      recipe: { name: 'mix', sources: [] },
    })
    expect(parseRecipeJson('[]')).toEqual({ ok: false, reason: 'not_object' })
    expect(parseRecipeJson('{')).toMatchObject({ ok: false, reason: 'invalid_json' })
  })
})
