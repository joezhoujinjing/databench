import { describe, expect, test } from 'vitest'
import {
  deriveVocabulary,
  listVocabularies,
  normalizeVocabulary,
  saveVocabulary,
  validateVocabulary,
} from './vocabularies.js'

describe('vocabulary API helpers', () => {
  test('lists vocabularies with clamped pagination', async () => {
    const result = await listVocabularies({
      base: 'http://api.example.test',
      fetch(input) {
        expect(String(input)).toBe('http://api.example.test/v1/vocabularies?limit=500&offset=5')
        return Promise.resolve(Response.json({ items: [], limit: 500, offset: 5, total: 0 }))
      },
      limit: 999,
      offset: 5,
      token: '',
    })

    expect(result.limit).toBe(500)
  })

  test('derives with query params and omits empty extractor body', async () => {
    await deriveVocabulary({
      base: '',
      dataset: 'raw labels',
      dimension: 'brand',
      fetch(input, init) {
        expect(String(input)).toBe(
          '/v1/vocabularies/brand%20v1:derive?dataset=raw+labels&dimension=brand',
        )
        expect(init?.method).toBe('POST')
        expect(init?.body).toBeUndefined()
        return Promise.resolve(Response.json(vocabulary()))
      },
      name: 'brand v1',
      token: '',
    })
  })

  test('sends extractor JSON when supplied', async () => {
    await deriveVocabulary({
      base: '',
      dataset: 'raw',
      dimension: 'brand',
      extractor: { source: 'assistant_json', raw_key: 'raw_brand', std_key: 'std_brand' },
      fetch(_input, init) {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(String(init?.body))).toEqual({
          source: 'assistant_json',
          raw_key: 'raw_brand',
          std_key: 'std_brand',
        })
        return Promise.resolve(Response.json(vocabulary()))
      },
      name: 'brand',
      token: '',
    })
  })

  test('saves curated vocabulary with a PUT body', async () => {
    await saveVocabulary({
      base: '',
      fetch(input, init) {
        expect(String(input)).toBe('/v1/vocabularies/brand')
        expect(init?.method).toBe('PUT')
        expect(JSON.parse(String(init?.body))).toMatchObject({ dimension: 'brand' })
        return Promise.resolve(Response.json(vocabulary()))
      },
      name: 'brand',
      payload: {
        dimension: 'brand',
        meta: {},
        name: 'brand',
        source: null,
        status: 'curated',
        terms: [{ aliases: ['远东'], canonical: '远东电缆', meta: {} }],
      },
      token: '',
    })
  })

  test('applies vocabularies with optional output refs', async () => {
    await normalizeVocabulary({
      base: '',
      dataset: 'raw',
      fetch(input) {
        expect(String(input)).toBe('/v1/vocabularies/brand:normalize?dataset=raw&ref=brand-clean')
        return Promise.resolve(Response.json(manifest()))
      },
      name: 'brand',
      ref: 'brand-clean',
      token: '',
    })

    await validateVocabulary({
      base: '',
      dataset: 'raw',
      fetch(input) {
        expect(String(input)).toBe('/v1/vocabularies/brand:validate?dataset=raw')
        return Promise.resolve(
          Response.json({
            dataset: manifest(),
            summary: { checked: 1, invalid: 0, offending_values: {} },
          }),
        )
      },
      name: 'brand',
      ref: '',
      token: '',
    })
  })
})

function vocabulary() {
  return {
    dimension: 'brand',
    id: 'vocab-id',
    meta: {},
    name: 'brand',
    source: null,
    status: 'curated',
    terms: [{ aliases: [], canonical: '远东电缆', meta: {} }],
  }
}

function manifest() {
  return {
    columns: [],
    created_at: '2026-01-01T00:00:00.000Z',
    hash_algo: 'blake3',
    kinds: { sft: 1 },
    name: 'raw',
    num_rows: 1,
    schema_version: '1',
    version: 'version',
  }
}
