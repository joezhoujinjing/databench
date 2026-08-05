import { fileURLToPath } from 'node:url'
import type { V2Workspace, WorkerRuntime } from '@databench/workspace'
import { describe, expect, test, vi } from 'vitest'
import { createApp, createOpenApiDocument } from '../src/app.js'
import { createAppFromConfig, loadConfig, startApiRuntime } from '../src/index.js'
import { createTestApp } from './test-app.js'

function modelEndpointSecurityDefaults() {
  return {
    connectTimeoutMs: 2_000,
    headersTimeoutMs: 3_000,
    bodyTimeoutMs: 3_000,
    totalTimeoutMs: 5_000,
  }
}

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
    expect(config.evaluationArchiveMaxBytes).toBe(1024 * 1024 * 1024)
    expect(config.evaluationArchiveSignedUrlTtlMs).toBe(15 * 60 * 1000)
    expect(config.worker).toMatchObject({
      enabled: false,
      target: '127.0.0.1:50051',
      leaseMs: 30_000,
      heartbeatMs: 10_000,
    })
    expect(() =>
      loadConfig({
        DATABENCH_EVALUATION_ARCHIVE_MAX_BYTES: String(1024 * 1024 * 1024 + 1),
        DATABENCH_OBJECT_STORE: 's3',
        DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
        S3_BUCKET: 'v2-config-test',
      }),
    ).toThrow()
    expect(() =>
      loadConfig({
        DATABENCH_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS: String(15 * 60 * 1000 + 1),
        DATABENCH_OBJECT_STORE: 's3',
        DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
        S3_BUCKET: 'v2-config-test',
      }),
    ).toThrow()
  })

  test('accepts only coherent private Worker runtime configuration', () => {
    const base = {
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      DATABENCH_WORKER_ENABLED: 'true',
      S3_BUCKET: 'v2-config-test',
    }
    expect(
      loadConfig({ ...base, DATABENCH_WORKER_TARGET: '10.20.30.40:50051' }).worker,
    ).toMatchObject({
      enabled: true,
      target: '10.20.30.40:50051',
    })
    expect(loadConfig({ ...base, DATABENCH_WORKER_TARGET: 'worker:50051' }).worker).toMatchObject({
      enabled: true,
      target: 'worker:50051',
    })
    expect(() => loadConfig({ ...base, DATABENCH_WORKER_TARGET: 'worker:50052' })).toThrow()
    expect(() => loadConfig({ ...base, DATABENCH_WORKER_TARGET: 'worker.example:50051' })).toThrow()
    expect(() => loadConfig({ ...base, DATABENCH_WORKER_TARGET: '8.8.8.8:50051' })).toThrow()
    expect(() => loadConfig({ ...base, DATABENCH_WORKER_LEASE_MS: '20000' })).toThrow()
    expect(() => loadConfig({ ...base, DATABENCH_WORKER_SIGNED_URL_TTL_MS: '910000' })).toThrow()
  })

  test('loads the internal Model Deployment service credential', () => {
    const base = {
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      S3_BUCKET: 'v2-config-test',
    }
    const service = 'service-token-that-is-distinct-and-long-enough'
    expect(
      loadConfig({
        ...base,
        DATABENCH_SERVICE_CREDENTIAL: service,
      }),
    ).toMatchObject({
      modelDeploymentServiceCredential: service,
    })
  })

  test('defaults Model Repository resolution offline and validates connected configuration', () => {
    const base = {
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      S3_BUCKET: 'v2-config-test',
    }

    expect(loadConfig(base).modelRepository).toEqual({ mode: 'offline', timeoutMs: 5_000 })
    expect(
      loadConfig({
        ...base,
        DATABENCH_MODEL_REPOSITORY_MODE: 'connected',
        DATABENCH_MODEL_REPOSITORY_CONFIG: ' /etc/databench/model-repositories.json ',
        DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS: '30000',
      }).modelRepository,
    ).toEqual({
      mode: 'connected',
      operatorConfigPath: '/etc/databench/model-repositories.json',
      timeoutMs: 30_000,
    })
    expect(() => loadConfig({ ...base, DATABENCH_MODEL_REPOSITORY_MODE: 'public' })).toThrow()
    expect(() =>
      loadConfig({ ...base, DATABENCH_MODEL_REPOSITORY_CONFIG: './repositories.json' }),
    ).toThrow('Path must be absolute')
    expect(() => loadConfig({ ...base, DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS: '99' })).toThrow()
    expect(() => loadConfig({ ...base, DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS: '30001' })).toThrow()
  })

  test('keeps EvalScope disabled by default and validates enabled internal routing', () => {
    const base = {
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      S3_BUCKET: 'v2-config-test',
    }
    expect(loadConfig(base).evalscope).toMatchObject({
      enabled: false,
      intranetHttpDocuments: false,
      proxyPrefix: '/evalscope-api',
    })
    const manifest = fileURLToPath(
      new URL('../../../deploy/evalscope/api-routes.json', import.meta.url),
    )
    expect(
      loadConfig({
        ...base,
        DATABENCH_EVALSCOPE_ENABLED: 'true',
        DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS: 'true',
        DATABENCH_EVALSCOPE_INTERNAL_BASE_URL: 'http://evalscope:9000',
        DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST: manifest,
      }).evalscope,
    ).toMatchObject({
      enabled: true,
      intranetHttpDocuments: true,
      internalBaseUrl: 'http://evalscope:9000',
      routeManifestPath: manifest,
    })
    expect(() =>
      loadConfig({
        ...base,
        DATABENCH_EVALSCOPE_ENABLED: 'true',
        DATABENCH_EVALSCOPE_INTERNAL_BASE_URL: 'https://public.example',
        DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST: manifest,
      }),
    ).toThrow()
    expect(() =>
      loadConfig({
        ...base,
        DATABENCH_EVALSCOPE_ENABLED: 'true',
        DATABENCH_EVALSCOPE_INTERNAL_BASE_URL: 'http://evalscope:9000',
      }),
    ).toThrow()
  })

  test('keeps Swift Studio disabled by default and loads only locked private routing', () => {
    const base = {
      DATABENCH_OBJECT_STORE: 's3',
      DATABENCH_V2_CURSOR_SECRET: 'databench-api-v2-config-secret',
      S3_BUCKET: 'v2-config-test',
    }
    expect(loadConfig(base).swiftStudio).toMatchObject({
      enabled: false,
      proxyPrefix: '/swift-studio',
    })
    const manifest = fileURLToPath(
      new URL('../../../third_party/ms-swift/gradio-routes.json', import.meta.url),
    )
    expect(
      loadConfig({
        ...base,
        DATABENCH_SWIFT_STUDIO_ENABLED: 'true',
        DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: 'http://api:8000',
        DATABENCH_SWIFT_STUDIO_IMAGE_DIGEST: 'a'.repeat(64),
        DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: 'http://swift-studio:7860',
        DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: 'http://swift-studio:7861',
        DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: manifest,
      }).swiftStudio,
    ).toMatchObject({
      enabled: true,
      databenchBaseUrl: 'http://api:8000',
      imageDigest: 'a'.repeat(64),
      internalBaseUrl: 'http://swift-studio:7860',
      providerBaseUrl: 'http://swift-studio:7861',
      routeManifestPath: manifest,
    })
    expect(() =>
      loadConfig({
        ...base,
        DATABENCH_SWIFT_STUDIO_ENABLED: 'true',
        DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: 'http://api:8000',
        DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: 'http://swift-studio:7860',
        DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: 'http://public.example:7861',
        DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: manifest,
      }),
    ).toThrow('private HTTP origin')
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
      evaluationArchiveMaxBytes: 1_073_741_824,
      evaluationArchiveSignedUrlTtlMs: 900_000,
      mcp: { enabled: false },
      modelEndpointSecurity: modelEndpointSecurityDefaults(),
      modelRepository: { mode: 'offline', timeoutMs: 5_000 },
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

  test('real runtime lifecycle never constructs Worker machinery while disabled', async () => {
    const workspace = {
      close: vi.fn(async () => {}),
    } as unknown as V2Workspace
    const openWorkspace = vi.fn(async () => workspace)
    const openWorker = vi.fn()
    const runtime = await startApiRuntime(
      {
        corsOrigins: [],
        evaluationArchiveMaxBytes: 1_073_741_824,
        evaluationArchiveSignedUrlTtlMs: 900_000,
        mcp: { enabled: false },
        modelEndpointSecurity: modelEndpointSecurityDefaults(),
        modelRepository: { mode: 'offline', timeoutMs: 5_000 },
        port: 0,
        storeConfig: { bucket: 'unused', region: 'us-east-1' },
        v2CursorSecret: 'databench-api-v2-test-cursor-secret',
        version: '1.0.0',
        workspaceRoot: './bench-test',
        worker: {
          enabled: false,
          target: '127.0.0.1:50051',
          jobDeadlineMs: 900_000,
          leaseMs: 30_000,
          heartbeatMs: 10_000,
          terminalEofMs: 5_000,
          signedUrlTtlMs: 1_200_000,
          shutdownMs: 30_000,
        },
      },
      {
        openWorkspace,
        openWorkerRuntime: openWorker,
        serve: (await import('@hono/node-server')).serve,
      },
    )

    expect(openWorkspace).toHaveBeenCalledOnce()
    expect(openWorker).not.toHaveBeenCalled()
    await runtime.close()
    expect(workspace.close).toHaveBeenCalledOnce()
  })

  test('enabled runtime starts Worker before HTTP and stops Worker before Workspace', async () => {
    const events: string[] = []
    const workspace = {
      close: vi.fn(async () => {
        events.push('workspace:close')
      }),
    } as unknown as V2Workspace
    const worker: WorkerRuntime = {
      supportsCapability(name, version) {
        return name === 'data_juicer.batch' && version === '1'
      },
      async start() {
        events.push('worker:start')
      },
      async stop() {
        events.push('worker:stop')
      },
    }
    const runtime = await startApiRuntime(
      {
        corsOrigins: [],
        evaluationArchiveMaxBytes: 1_073_741_824,
        evaluationArchiveSignedUrlTtlMs: 900_000,
        mcp: { enabled: false },
        modelEndpointSecurity: modelEndpointSecurityDefaults(),
        modelRepository: { mode: 'offline', timeoutMs: 5_000 },
        port: 0,
        storeConfig: { bucket: 'unused', region: 'us-east-1' },
        v2CursorSecret: 'databench-api-v2-test-cursor-secret',
        version: '1.0.0',
        workspaceRoot: './bench-test',
        worker: {
          enabled: true,
          target: '127.0.0.1:50051',
          jobDeadlineMs: 900_000,
          leaseMs: 30_000,
          heartbeatMs: 10_000,
          terminalEofMs: 5_000,
          signedUrlTtlMs: 1_200_000,
          shutdownMs: 30_000,
        },
      },
      {
        openWorkspace: async () => workspace,
        openWorkerRuntime: async () => worker,
        serve: (await import('@hono/node-server')).serve,
      },
    )
    events.push('http:started')
    await runtime.close()

    expect(events).toEqual(['worker:start', 'http:started', 'worker:stop', 'workspace:close'])
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
