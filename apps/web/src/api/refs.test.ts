import { describe, expect, test } from 'vitest'
import { listRefs, resolveRef } from './refs.js'

describe('refs API helpers', () => {
  test('defaults refs list to the old UI 200-row page and encodes query', async () => {
    const result = await listRefs({
      base: 'http://api.example.test',
      fetch(input) {
        expect(String(input)).toBe('http://api.example.test/v1/refs?limit=200&offset=0')
        return Promise.resolve(Response.json({ items: [], limit: 200, offset: 0, total: 0 }))
      },
      limit: 200,
      token: '',
    })

    expect(result.limit).toBe(200)
  })

  test('resolves ref names with path encoding', async () => {
    const result = await resolveRef({
      base: '',
      fetch(input) {
        expect(String(input)).toBe('/v1/refs/name%2Fwith%20slash')
        return Promise.resolve(Response.json({ name: 'name/with slash', version: 'v1' }))
      },
      name: 'name/with slash',
      token: '',
    })

    expect(result.version).toBe('v1')
  })
})
