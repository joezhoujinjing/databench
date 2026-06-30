import { describe, expect, test } from 'vitest'
import {
  createDataset,
  exportDatasetResponse,
  exportFilename,
  getSamples,
  nextSamplePageParam,
} from './datasets.js'
import type { SamplesPage } from './types.js'

describe('dataset API helpers', () => {
  test('computes the next sample page offset from backend pagination fields', () => {
    expect(nextSamplePageParam(page({ limit: 20, offset: 0, total: 45 }))).toBe(20)
    expect(nextSamplePageParam(page({ limit: 20, offset: 40, total: 45 }))).toBeUndefined()
  })

  test('clamps sample limits and encodes refs through the generated client path', async () => {
    const result = await getSamples({
      base: 'http://api.example.test',
      fetch(input, init) {
        expect(String(input)).toBe(
          'http://api.example.test/v1/datasets/ref%2Fwith%20slash/samples?limit=500&offset=5',
        )
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-a')
        return Promise.resolve(Response.json(page({ limit: 500, offset: 5, total: 0 })))
      },
      limit: 999,
      offset: 5,
      ref: 'ref/with slash',
      token: 'token-a',
    })

    expect(result.limit).toBe(500)
  })

  test('posts JSON sample creation requests through the generated request type', async () => {
    const sample = { kind: 'sft' as const, messages: [message('user', 'hello')] }

    await createDataset({
      base: '',
      fetch(input, init) {
        expect(String(input)).toBe('/v1/datasets')
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(String(init?.body))).toEqual({
          name: 'raw',
          samples: [sample],
        })
        return Promise.resolve(Response.json(manifest()))
      },
      payload: {
        name: 'raw',
        samples: [sample],
      },
      token: '',
    })
  })

  test('downloads export through the raw response path with bearer auth', async () => {
    const response = await exportDatasetResponse({
      base: 'http://api.example.test',
      fetch(input, init) {
        expect(String(input)).toBe(
          'http://api.example.test/v1/datasets/ref%20name/export?fmt=messages-jsonl',
        )
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
        return Promise.resolve(new Response('{"messages":[]}\n'))
      },
      ref: 'ref name',
      token: 'secret',
    })

    expect(await response.text()).toBe('{"messages":[]}\n')
  })

  test('export response errors are parsed as API envelopes', async () => {
    await expect(
      exportDatasetResponse({
        base: '',
        fetch: () =>
          Promise.resolve(
            Response.json(
              { error: { code: 'not_found', message: 'missing dataset' } },
              { status: 404 },
            ),
          ),
        ref: 'missing',
        token: '',
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'missing dataset', status: 404 })
  })

  test('sanitizes export filenames without trusting content-disposition', () => {
    expect(exportFilename('ref/with spaces', 'messages-jsonl')).toBe(
      'ref_with_spaces.messages-jsonl.jsonl',
    )
    expect(exportFilename('   ', 'trl')).toBe('dataset.trl.jsonl')
  })
})

function page(overrides: Partial<SamplesPage>): SamplesPage {
  return {
    items: [],
    limit: 20,
    offset: 0,
    total: 0,
    ...overrides,
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
    version: 'v1',
  }
}

function message(role: 'system' | 'user' | 'assistant' | 'tool', content: string | null) {
  return {
    content,
    name: null,
    role,
    tool_call_id: null,
    tool_calls: null,
  }
}
