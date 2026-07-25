import { describe, expect, test } from 'vitest'
import { createApp, createOpenApiDocument } from '../src/app.js'
import { createAppFromConfig, loadConfig } from '../src/index.js'
import { createTestApp } from './test-app.js'

describe('api support', () => {
  test('fails closed when the V2 cursor secret is missing at runtime', () => {
    expect(() => createApp()).toThrow(
      'createApp requires v2CursorSecret when a V2 Workspace is not injected',
    )
    expect(() => createApp({ v2CursorSecret: 'too-short-for-production' })).not.toThrow()
    expect(() => createOpenApiDocument()).not.toThrow()
  })

  test('requires and loads the V2 cursor secret from the service environment', () => {
    expect(() => loadConfig({ DATABENCH_OBJECT_STORE: 's3' })).toThrow()
    expect(() =>
      loadConfig({
        DATABENCH_OBJECT_STORE: 's3',
        DATABENCH_V2_CURSOR_SECRET: 'short',
      }),
    ).toThrow()

    const config = loadConfig({
      DATABENCH_CORS_ORIGINS: ' https://one.example,https://two.example ',
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_OPENAPI_SERVER_URL: ' /api ',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      S3_BUCKET: 'v2-config-test',
    })

    expect(config.v2CursorSecret).toBe('databench-api-v2-config-secret')
    expect(config.corsOrigins).toEqual(['https://one.example', 'https://two.example'])
    expect(config.openApiServerUrl).toBe('/api')
    expect(config.storeConfig).toMatchObject({ kind: 's3', bucket: 'v2-config-test' })
  })

  test('meta routes expose the v2-only health, version, and capability contract', async () => {
    const app = createTestApp({ version: '1.2.3', workspaceRoot: './bench-test' })

    const health = await getJson<Record<string, unknown>>(app.fetch(request('/health')))
    expect(health).toEqual({
      status: 'ok',
      workspace_root: './bench-test',
      version: '1.2.3',
    })

    const version = await getJson<Record<string, unknown>>(app.fetch(request('/version')))
    expect(version).toEqual({
      api_version: 'v2',
      service_version: '1.2.3',
      schema_version: '2.0.0',
    })

    const capabilities = await getJson<Record<string, unknown>>(app.fetch(request('/capabilities')))
    expect(capabilities).toMatchObject({
      api_version: 'v2',
      min_client: '0.1.0',
      post_training_v2: {
        api_versions: ['2'],
        enabled: true,
        record_schema_versions: ['2.0.0'],
      },
    })
    expect(capabilities).not.toHaveProperty('features')
  })

  test('does not register legacy unversioned domain routes', async () => {
    const app = createTestApp()

    expect((await app.fetch(request('/datasets'))).status).toBe(404)
    expect((await app.fetch(request('/refs'))).status).toBe(404)
  })

  test('cors allows local dev and sets PNA only when requested', async () => {
    const app = createTestApp()
    const response = await app.fetch(
      request('/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-private-network': 'true',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('access-control-allow-private-network')).toBe('true')

    const ordinary = await app.fetch(
      request('/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'GET',
        },
      }),
    )
    expect(ordinary.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    expect(ordinary.headers.has('access-control-allow-private-network')).toBe(false)
  })

  test('cors configured origins are exact and reject lookalikes', async () => {
    const app = createTestApp({ corsOrigins: ['https://databench.jinjing.me'] })

    const allowed = await app.fetch(
      request('/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://databench.jinjing.me',
          'access-control-request-method': 'GET',
        },
      }),
    )
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://databench.jinjing.me')

    const rejected = await app.fetch(
      request('/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://databench.jinjing.me.evil.com',
          'access-control-request-method': 'GET',
        },
      }),
    )
    expect(rejected.headers.has('access-control-allow-origin')).toBe(false)
  })

  test('entrypoint config is passed into app creation', async () => {
    const app = createAppFromConfig({
      corsOrigins: ['https://web.example.test'],
      mcp: { enabled: false },
      openApiServerUrl: '/api',
      port: 8000,
      storeConfig: {
        bucket: 'databench-test',
        region: 'us-east-1',
      },
      v2CursorSecret: 'databench-api-v2-test-cursor-secret',
      version: '9.9.9',
      workspaceRoot: './configured-root',
    })

    const health = await getJson<Record<string, unknown>>(app.fetch(request('/health')))
    expect(health).toMatchObject({
      version: '9.9.9',
      workspace_root: './configured-root',
    })

    const allowed = await app.fetch(
      request('/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://web.example.test',
          'access-control-request-method': 'GET',
        },
      }),
    )
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://web.example.test')

    const openApi = await getJson<OpenApiDocument>(app.fetch(request('/openapi.json')))
    expect(openApi.servers).toEqual([{ url: '/api' }])
  })

  test('openapi document is generated from registered zod routes with error responses', () => {
    const document = createOpenApiDocument({
      openApiServerUrl: '/api',
      version: '1.2.3',
    }) as OpenApiDocument

    expect(document.info.title).toBe('databench service')
    expect(document.servers).toEqual([{ url: '/api' }])
    expect(document.components.schemas.ErrorResponse).toBeDefined()
    expect(document.paths['/health']?.get.responses.default).toMatchObject({
      description: 'Error response',
    })
    expect(document.paths['/version']?.get.responses[200]).toBeDefined()
    expect(document.paths['/capabilities']?.get.responses[200]).toBeDefined()
    expect(Object.keys(document.paths).some((path) => path.startsWith('/v1'))).toBe(false)
    expect(document.paths['/v2/datasets/{ref_or_version}']?.get?.responses[200]).toBeDefined()
  })
})

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

async function getJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

interface OpenApiDocument {
  readonly components: {
    readonly schemas: Record<string, unknown>
  }
  readonly info: {
    readonly title: string
  }
  readonly paths: Record<
    string,
    {
      readonly get?: {
        readonly responses: Record<string | number, unknown>
      }
      readonly put?: {
        readonly responses: Record<string | number, unknown>
      }
    }
  >
  readonly servers?: readonly { readonly url: string }[]
}
