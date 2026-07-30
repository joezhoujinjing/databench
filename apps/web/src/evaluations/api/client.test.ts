import { describe, expect, test, vi } from 'vitest'
import benchmarkFixture from '../fixtures/benchmarks-five-categories.json'
import { createEvalScopeClient } from './client.js'
import { EVALSCOPE_PLOTLY_ASSET_SHA256, EVALSCOPE_UPSTREAM_COMMIT } from './config.js'
import type { EvalScopeApiError } from './errors.js'
import {
  benchmarksResponseSchema,
  evalScopePublicConfigSchema,
  generatedDocumentDescriptorSchema,
} from './schemas.js'

const configFixture = {
  service_version: '0.1.0',
  evalscope_commit: EVALSCOPE_UPSTREAM_COMMIT,
  capabilities: [
    'evaluation',
    'performance',
    'reports',
    'databench-dataset',
    'databench-model-deployment',
    'generated-documents',
  ],
  reports_configured: true,
  report_root_generation: '4',
  plotly_asset_sha256: EVALSCOPE_PLOTLY_ASSET_SHA256,
} as const

describe('EvalScope exact client', () => {
  test('uses the fixed same-origin config operation and validates its response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(configFixture))
    const client = createEvalScopeClient(fetchImplementation)

    await expect(client.request('config')).resolves.toEqual(configFixture)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('/evalscope-api/api/v1/config')
  })

  test('rejects fields outside the reviewed query manifest before fetch', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const client = createEvalScopeClient(fetchImplementation)

    await expect(
      client.request('reportsList', {
        query: { root_path: '/tmp/reports' } as never,
      }),
    ).rejects.toMatchObject({ kind: 'validation' })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  test('requires a valid task header for invoke and sends exact JSON', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ status: 'completed', task_id: 'eval_12345678-1234-4123-8123-123456789abc' }),
    )
    const client = createEvalScopeClient(fetchImplementation)
    const taskId = 'eval_12345678-1234-4123-8123-123456789abc'

    await client.request('evalInvoke', { body: { model: 'demo' }, taskId })
    const init = fetchImplementation.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('evalscope-task-id')).toBe(taskId)
    expect(init?.body).toBe('{"model":"demo"}')
  })

  test('maps a disabled gateway config route to unavailable', async () => {
    const client = createEvalScopeClient(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { error: { code: 'not_found', message: 'Endpoint not found' } },
          { status: 404 },
        ),
      ),
    )

    await expect(client.request('config')).rejects.toEqual(
      expect.objectContaining<Partial<EvalScopeApiError>>({
        code: 'not_found',
        kind: 'unavailable',
        status: 404,
      }),
    )
  })

  test('preserves safe field pointers for dataset_args admission errors', async () => {
    const client = createEvalScopeClient(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            error: {
              code: 'dataset_args_locator_forbidden',
              field: '/dataset_args/gsm8k/local_path',
              message: 'Dataset Args contains a forbidden locator',
            },
          },
          { status: 422 },
        ),
      ),
    )

    await expect(
      client.request('evalInvoke', {
        body: { dataset_args: { local_path: '/tmp/data' } },
        taskId: 'eval_12345678-1234-4123-8123-123456789abc',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EvalScopeApiError>>({
        code: 'dataset_args_locator_forbidden',
        field: '/dataset_args/gsm8k/local_path',
        status: 422,
      }),
    )
  })

  test('derives generated document and asset URLs from the fixed gateway', () => {
    const client = createEvalScopeClient(vi.fn<typeof fetch>())
    const descriptor = {
      document_id: 'a'.repeat(43),
      document_url: `/evalscope-api/generated-documents/${'a'.repeat(43)}`,
      expires_at: 2_000_000_000,
      kind: 'evaluation-report',
    }

    expect(client.generatedDocumentUrl(descriptor)).toBe(descriptor.document_url)
    expect(client.plotlyAssetUrl()).toBe(
      `/evalscope-api/generated-assets/plotly-${EVALSCOPE_PLOTLY_ASSET_SHA256}.min.js`,
    )
  })
})

describe('path-free public schemas', () => {
  test('rejects server filesystem fields instead of silently stripping them', () => {
    expect(
      evalScopePublicConfigSchema.safeParse({ ...configFixture, outputs_root: '/srv/outputs' })
        .success,
    ).toBe(false)
    expect(
      evalScopePublicConfigSchema.safeParse({ ...configFixture, inputs_root: 'C:\\inputs' })
        .success,
    ).toBe(false)
  })

  test('binds a generated document URL to its opaque id', () => {
    const parsed = generatedDocumentDescriptorSchema.safeParse({
      document_id: 'a'.repeat(43),
      document_url: `/evalscope-api/generated-documents/${'b'.repeat(43)}`,
      expires_at: 2_000_000_000,
      kind: 'evaluation-chart',
    })
    expect(parsed.success).toBe(false)
  })

  test('accepts the pinned five-category Benchmark response fixture', () => {
    const parsed = benchmarksResponseSchema.parse(benchmarkFixture.response)
    expect(parsed.text).toHaveLength(1)
    expect(parsed.multimodal).toHaveLength(1)
    expect(parsed.agent).toHaveLength(1)
    expect(parsed.aigc).toHaveLength(1)
  })
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}
