import { describe, expect, test } from 'vitest'
import { getLineage } from './lineage.js'

describe('lineage API helpers', () => {
  test('gets lineage with path-encoded refs', async () => {
    const lineage = await getLineage({
      base: '',
      fetch(input) {
        expect(String(input)).toBe('/v1/lineage/ref%2Fwith%20slash')
        return Promise.resolve(Response.json({ version: 'ref/with slash' }))
      },
      ref: 'ref/with slash',
      token: '',
    })

    expect(lineage.version).toBe('ref/with slash')
  })
})
