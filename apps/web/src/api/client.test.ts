import { describe, expect, test, vi } from 'vitest'
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
    expect(buildUrl('/api///', '/health', { ok: true })).toBe('/api/health?ok=true')
    expect(buildUrl('http://api.example.test///', 'v1/refs', { limit: 20 })).toBe(
      'http://api.example.test/v1/refs?limit=20',
    )
    expect(buildUrl('http://api.example.test/gateway///', '/v2/refs')).toBe(
      'http://api.example.test/gateway/v2/refs',
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

  test('raw requests preserve a same-origin path base', async () => {
    const response = await rawRequest('/v2/refs', {
      base: '/api',
      fetch(input) {
        expect(String(input)).toBe('/api/v2/refs?limit=1')
        return Promise.resolve(Response.json({ items: [], limit: 1, offset: 0, total: 0 }))
      },
      query: { limit: 1 },
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

  test('openapi-fetch client preserves a same-origin path base in a browser', async () => {
    class BrowserRequest extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === 'string' && input.startsWith('/')
            ? `http://browser.example.test${input}`
            : input,
          init,
        )
      }
    }

    vi.stubGlobal('Request', BrowserRequest)
    try {
      const client = createApiClient({
        base: '/api',
        fetch(request) {
          expect(request.url).toBe('http://browser.example.test/api/health')
          return Promise.resolve(
            Response.json({ status: 'ok', version: '0.0.0', workspace_root: './bench' }),
          )
        },
      })

      await expect(unwrapOpenApiResponse(client.GET('/health'))).resolves.toMatchObject({
        status: 'ok',
      })
    } finally {
      vi.unstubAllGlobals()
    }
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
