import { describe, expect, test } from 'vitest'
import {
  buildUrl,
  createApiClient,
  rawRequest,
  serializeQuery,
  unwrapOpenApiResponse,
} from './client.js'
import { ApiError } from './errors.js'

describe('api client transport', () => {
  test('builds URLs and skips nullish query values', () => {
    expect(serializeQuery({ a: 1, b: null, c: undefined, d: 'x y' })).toBe('a=1&d=x+y')
    expect(buildUrl('', '/health', { ok: true })).toBe('/health?ok=true')
    expect(buildUrl('http://api.example.test///', 'v1/refs', { limit: 20 })).toBe(
      'http://api.example.test/v1/refs?limit=20',
    )
  })

  test('raw requests attach per-backend bearer tokens', async () => {
    const response = await rawRequest('/v1/refs', {
      base: 'http://api.example.test',
      fetch(input, init) {
        expect(String(input)).toBe('http://api.example.test/v1/refs?limit=20')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-a')
        return Promise.resolve(Response.json({ items: [], limit: 20, offset: 0, total: 0 }))
      },
      query: { limit: 20, offset: null },
      token: ' token-a ',
    })

    expect(response.ok).toBe(true)
  })

  test('openapi-fetch client uses runtime base and Authorization header', async () => {
    const client = createApiClient({
      base: 'http://api.example.test',
      fetch(request) {
        expect(request.url).toBe('http://api.example.test/health')
        expect(request.headers.get('authorization')).toBe('Bearer secret')
        return Promise.resolve(
          Response.json({ status: 'ok', version: '0.0.0', workspace_root: './bench' }),
        )
      },
      token: 'secret',
    })

    await expect(unwrapOpenApiResponse(client.GET('/health'))).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('unwrapOpenApiResponse throws ApiError for parsed error bodies', async () => {
    const client = createApiClient({
      base: 'http://api.example.test',
      fetch() {
        return Promise.resolve(
          Response.json({ error: { code: 'not_found', message: 'missing' } }, { status: 404 }),
        )
      },
    })

    await expect(unwrapOpenApiResponse(client.GET('/health'))).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
  })

  test('raw request network failures become ApiError status 0', async () => {
    await expect(
      rawRequest('/health', {
        fetch() {
          return Promise.reject(new Error('offline'))
        },
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})
