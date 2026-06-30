import { describe, expect, test } from 'vitest'
import { listTransforms, runTransform } from './transforms.js'

describe('transform API helpers', () => {
  test('lists transforms with a capped 500-row page', async () => {
    await listTransforms({
      base: '',
      fetch(input) {
        expect(String(input)).toBe('/v1/transforms?limit=500&offset=0')
        return Promise.resolve(Response.json({ items: [], limit: 500, offset: 0, total: 0 }))
      },
      limit: 999,
      token: '',
    })
  })

  test('runs transforms with encoded names and explicit empty params', async () => {
    await runTransform({
      base: '',
      fetch(input, init) {
        expect(String(input)).toBe('/v1/transforms/enrich%2Flength/run')
        expect(JSON.parse(String(init?.body))).toEqual({
          inputs: ['raw'],
          params: {},
          ref: null,
        })
        return Promise.resolve(Response.json(manifest()))
      },
      name: 'enrich/length',
      payload: { inputs: ['raw'], params: {}, ref: null },
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
    name: 'raw',
    num_rows: 1,
    schema_version: '1',
    version: 'v1',
  }
}
