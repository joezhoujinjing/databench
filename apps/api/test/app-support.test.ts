import { Workspace } from '@databench/workspace'
import { describe, expect, test } from 'vitest'
import { createApp, createOpenApiDocument } from '../src/app.js'
import { createAppFromConfig } from '../src/index.js'

describe('api support', () => {
  test('meta routes expose Python-compatible health, version, and capabilities shapes', async () => {
    const app = createApp({ version: '1.2.3', workspaceRoot: './bench-test' })

    const health = await getJson<Record<string, unknown>>(app.fetch(request('/health')))
    expect(health).toEqual({
      status: 'ok',
      workspace_root: './bench-test',
      version: '1.2.3',
    })

    const version = await getJson<Record<string, unknown>>(app.fetch(request('/version')))
    expect(version).toEqual({
      api_version: 'v1',
      service_version: '1.2.3',
      schema_version: '1',
    })

    const capabilities = await getJson<{
      features: Record<string, boolean>
    }>(app.fetch(request('/capabilities')))
    expect(capabilities.features.transforms).toBe(true)
    expect(capabilities.features.recipes).toBe(true)
    expect(capabilities.features.lineage).toBe(true)
    expect(capabilities.features.jsonl_ingest).toBe(true)
    expect(capabilities.features.export).toBe(true)
    expect(capabilities.features.synthesis).toBe(false)
    expect(capabilities.features.annotation).toBe(false)
    expect(capabilities.features.vocabularies).toBe(true)
  })

  test('does not register legacy unversioned domain routes', async () => {
    const app = createApp()

    expect((await app.fetch(request('/datasets'))).status).toBe(404)
    expect((await app.fetch(request('/refs'))).status).toBe(404)
  })

  test('injects a shared workspace into versioned routes', async () => {
    const app = createApp({ workspace: Workspace.open({ root: './bench-test' }) })

    app.get('/v1/_test-workspace', (context) =>
      context.json({
        hasWorkspace: Boolean(context.get('workspace')),
      }),
    )

    expect(
      await getJson<{ hasWorkspace: boolean }>(app.fetch(request('/v1/_test-workspace'))),
    ).toEqual({
      hasWorkspace: true,
    })
  })

  test('cors allows local dev and sets PNA only when requested', async () => {
    const app = createApp()
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
    const app = createApp({ corsOrigins: ['https://databench.jinjing.me'] })

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
      port: 8000,
      storeConfig: {
        bucket: 'databench-test',
        region: 'us-east-1',
      },
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
  })

  test('openapi document is generated from registered zod routes with error responses', () => {
    const document = createOpenApiDocument({ version: '1.2.3' }) as OpenApiDocument

    expect(document.info.title).toBe('databench service')
    expect(document.components.schemas.ErrorResponse).toBeDefined()
    expect(document.paths['/health']?.get.responses.default).toMatchObject({
      description: 'Error response',
    })
    expect(document.paths['/version']?.get.responses[200]).toBeDefined()
    expect(document.paths['/capabilities']?.get.responses[200]).toBeDefined()
    expect(document.paths['/v1']?.get.responses[200]).toBeDefined()
    expect(document.paths['/v1/vocabularies']?.get.responses[200]).toBeDefined()
    expect(document.paths['/v1/vocabularies/{name}']?.put?.responses[200]).toBeDefined()
  })

  test('openapi document publishes concrete sample and lineage shapes', () => {
    const document = createOpenApiDocument() as OpenApiDocument
    const sample = schemaText(document, 'Sample')
    const ingest = schemaText(document, 'IngestSamplesRequest')
    const page = schemaText(document, 'SamplesPage')
    const lineage = schemaText(document, 'LineageNode')
    const vocabulary = schemaText(document, 'Vocabulary')
    const validate = schemaText(document, 'ValidateResponse')
    const validateSummary = schemaText(document, 'ValidateSummary')

    expect(sample).toContain('"messages"')
    expect(sample).toContain('"chosen"')
    expect(sample).toContain('"rollouts"')
    expect(ingest).toContain('"samples"')
    expect(page).toContain('"items"')
    expect(lineage).toContain('"produced_by"')
    expect(lineage).toContain('"inputs"')
    expect(lineage).toContain('#/components/schemas/LineageNode')
    expect(vocabulary).toContain('"terms"')
    expect(vocabulary).toContain('"dimension"')
    expect(validate).toContain('#/components/schemas/ValidateSummary')
    expect(validateSummary).toContain('"offending_values"')
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

function schemaText(document: OpenApiDocument, name: string): string {
  const schema = document.components.schemas[name]
  expect(schema, `${name} schema`).toBeDefined()

  return JSON.stringify(schema)
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
}
