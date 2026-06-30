import { describe, expect, test } from 'vitest'
import { materializeRecipe } from './recipes.js'

describe('recipe API helpers', () => {
  test('posts recipe materialization payloads', async () => {
    await materializeRecipe({
      base: '',
      fetch(input, init) {
        expect(String(input)).toBe('/v1/recipes:materialize')
        expect(JSON.parse(String(init?.body))).toEqual({
          recipe: { name: 'mix', sources: [{ dataset: 'raw', weight: 1 }] },
          ref: 'mix-latest',
        })
        return Promise.resolve(Response.json(manifest()))
      },
      payload: {
        recipe: { name: 'mix', sources: [{ dataset: 'raw', weight: 1 }] },
        ref: 'mix-latest',
      },
      token: '',
    })
  })
})

function manifest() {
  return {
    columns: [],
    created_at: '2026-01-01T00:00:00.000Z',
    hash_algo: 'blake3',
    kinds: { sft: 1 },
    name: 'mix',
    num_rows: 1,
    schema_version: '1',
    version: 'v1',
  }
}
