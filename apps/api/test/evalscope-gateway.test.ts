import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import type { EvalScopeGatewayConfig } from '../src/evalscope/config.js'
import { EVALSCOPE_PLOTLY_ASSET_SHA256 } from '../src/evalscope/routes.js'
import { createTestApp } from './test-app.js'

const TASK_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
const DOCUMENT_ID = 'a'.repeat(43)

function config(overrides: Partial<EvalScopeGatewayConfig> = {}): EvalScopeGatewayConfig {
  return {
    enabled: true,
    intranetHttpDocuments: false,
    internalBaseUrl: 'http://evalscope:9000',
    invokeTimeoutMs: 60_000,
    proxyPrefix: '/evalscope-api',
    requestMaxBytes: 1024,
    responseMaxBytes: 1024,
    routeManifestPath: fileURLToPath(
      new URL('../../../deploy/evalscope/api-routes.json', import.meta.url),
    ),
    timeoutMs: 5000,
    ...overrides,
  }
}

describe('EvalScope same-origin gateway', () => {
  test('is disabled by default and blocks every upstream surface', async () => {
    const app = createTestApp()
    expect((await app.fetch(request('/evalscope-api/health'))).status).toBe(404)
    expect((await app.fetch(request('/evalscope-api/'))).status).toBe(404)
  })

  test('forwards only the compiled exact method and path allowlist', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe('/health')
      return Response.json({ status: 'ok' })
    })
    const app = createTestApp({ evalscope: config(), evalscopeFetch: fetchMock as typeof fetch })
    const health = await app.fetch(request('/evalscope-api/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledOnce()

    for (const [method, path] of [
      ['GET', '/evalscope-api/'],
      ['GET', '/evalscope-api/dashboard'],
      ['POST', '/evalscope-api/api/v1/eval/resume/invoke'],
      ['GET', '/evalscope-api/api/v1/reports/scan'],
      ['GET', '/evalscope-api/api/v1/synthetic-new-endpoint'],
      ['GET', '/evalscope-api/internal/v1/operator/status'],
      ['POST', '/evalscope-api/health'],
    ]) {
      expect((await app.fetch(request(path, { method }))).status).toBe(404)
    }
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('materializes only the pinned Plotly asset digest', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe(
        `/generated-assets/plotly-${EVALSCOPE_PLOTLY_ASSET_SHA256}.min.js`,
      )
      return new Response('/* pinned plotly */', {
        headers: { 'content-type': 'application/javascript' },
      })
    })
    const app = createTestApp({ evalscope: config(), evalscopeFetch: fetchMock as typeof fetch })
    expect(
      (
        await app.fetch(
          request(`/evalscope-api/generated-assets/plotly-${EVALSCOPE_PLOTLY_ASSET_SHA256}.min.js`),
        )
      ).status,
    ).toBe(200)
    expect(
      (await app.fetch(request(`/evalscope-api/generated-assets/plotly-${'0'.repeat(64)}.min.js`)))
        .status,
    ).toBe(404)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('validates query fields before forwarding', async () => {
    const fetchMock = vi.fn(async () => Response.json({ reports: [] }))
    const app = createTestApp({ evalscope: config(), evalscopeFetch: fetchMock as typeof fetch })
    const arbitraryRoot = await app.fetch(
      request('/evalscope-api/api/v1/reports/list?root_path=/tmp'),
    )
    expect(arbitraryRoot.status).toBe(422)
    const duplicate = await app.fetch(
      request(`/evalscope-api/api/v1/eval/progress?task_id=${TASK_ID}&task_id=${TASK_ID}`),
    )
    expect(duplicate.status).toBe(422)
    const traversal = await app.fetch(request('/evalscope-api/api/v1/perf/detail?path=../private'))
    expect(traversal.status).toBe(422)
    const unreviewedChart = await app.fetch(
      request('/evalscope-api/api/v1/perf/chart?path=run&chart_type=external_script'),
    )
    expect(unreviewedChart.status).toBe(422)
    const missingRun = await app.fetch(
      request('/evalscope-api/api/v1/perf/chart?path=run&chart_type=req_latency'),
    )
    expect(missingRun.status).toBe(422)
    const comparePerRun = await app.fetch(
      request('/evalscope-api/api/v1/perf/compare/chart?paths=one;two&chart_type=req_latency'),
    )
    expect(comparePerRun.status).toBe(422)
    const incompleteHistogram = await app.fetch(
      request('/evalscope-api/api/v1/reports/chart?chart_type=histogram&report_name=run/model'),
    )
    expect(incompleteHistogram.status).toBe(422)
    const controlCharacter = await app.fetch(
      request('/evalscope-api/api/v1/reports/list?search=%0Asecret'),
    )
    expect(controlCharacter.status).toBe(422)
    const invalidPredictionMode = await app.fetch(
      request(
        '/evalscope-api/api/v1/reports/predictions?report_name=run/model&dataset_name=general_qa&subset_name=databench&mode=near',
      ),
    )
    expect(invalidPredictionMode.status).toBe(422)
    const conflictingPredictionLocator = await app.fetch(
      request(
        '/evalscope-api/api/v1/reports/predictions?report_name=run/model&dataset_name=general_qa&subset_name=databench&index=1&message_id_prefix=msg',
      ),
    )
    expect(conflictingPredictionLocator.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('bounds invoke JSON and strips browser credentials and cookies', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(new URL(input instanceof Request ? input.url : input).pathname).toBe(
          '/api/v1/eval/invoke',
        )
        const headers = new Headers(init?.headers)
        expect(headers.get('evalscope-task-id')).toBe(TASK_ID)
        expect(headers.get('authorization')).toBeNull()
        expect(headers.get('cookie')).toBeNull()
        expect(new TextDecoder().decode(init?.body as Uint8Array)).toContain('api_key')
        return Response.json({ status: 'completed', task_id: TASK_ID })
      },
    )
    const app = createTestApp({ evalscope: config(), evalscopeFetch: fetchMock as typeof fetch })
    const response = await app.fetch(
      request('/evalscope-api/api/v1/eval/invoke', {
        method: 'POST',
        headers: {
          authorization: 'Bearer browser-session',
          cookie: 'session=secret',
          'content-type': 'application/json',
          'evalscope-task-id': TASK_ID,
        },
        body: JSON.stringify({
          model: 'model',
          datasets: ['general_qa'],
          api_url: 'http://model:8000/v1',
          api_key: 'secret',
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()

    const invalid = await app.fetch(
      request('/evalscope-api/api/v1/eval/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'evalscope-task-id': TASK_ID },
        body: '[]',
      }),
    )
    expect(invalid.status).toBe(400)
  })

  test('generated documents require iframe context and preserve only safe headers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('sec-fetch-dest')).toBe('iframe')
      return new Response('<p>safe</p>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "sandbox; default-src 'none'",
          'set-cookie': 'upstream=secret',
          server: 'internal',
        },
      })
    })
    const app = createTestApp({ evalscope: config(), evalscopeFetch: fetchMock as typeof fetch })
    const path = `/evalscope-api/generated-documents/${DOCUMENT_ID}`
    expect((await app.fetch(request(path))).status).toBe(403)
    const framed = await app.fetch(request(path, { headers: { 'sec-fetch-dest': 'iframe' } }))
    expect(framed.status).toBe(200)
    expect(framed.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(framed.headers.has('set-cookie')).toBe(false)
    expect(framed.headers.has('server')).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('admits only same-origin Evaluation viewers when intranet HTTP omits fetch metadata', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('sec-fetch-dest')).toBe('iframe')
      return new Response('<p>safe</p>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "sandbox; default-src 'none'",
        },
      })
    })
    const app = createTestApp({
      evalscope: config({ intranetHttpDocuments: true }),
      evalscopeFetch: fetchMock as typeof fetch,
    })
    const path = `/evalscope-api/generated-documents/${DOCUMENT_ID}`
    const accepted = await app.fetch(
      request(path, { headers: { referer: 'http://databench.test/evaluations/reports/run' } }),
    )
    expect(accepted.status).toBe(200)

    for (const rejected of [
      request(path),
      request(path, { headers: { referer: 'http://evil.test/evaluations/reports/run' } }),
      request(path, { headers: { referer: 'http://databench.test/datasets' } }),
      request(path, {
        headers: {
          referer: 'http://databench.test/evaluations/reports/run',
          'sec-fetch-dest': 'document',
        },
      }),
      request(path, {
        headers: {
          referer: 'http://databench.test/evaluations/reports/run',
          'sec-fetch-site': 'same-origin',
        },
      }),
      new Request(`https://databench.test${path}`, {
        headers: { referer: 'https://databench.test/evaluations/reports/run' },
      }),
    ]) {
      expect((await app.fetch(rejected)).status).toBe(403)
    }
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('rejects redirects, oversized responses, and media-type confusion', async () => {
    const redirects = createTestApp({
      evalscope: config(),
      evalscopeFetch: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: 'http://evil.test' } }),
      ) as typeof fetch,
    })
    expect((await redirects.fetch(request('/evalscope-api/health'))).status).toBe(502)

    const oversized = createTestApp({
      evalscope: config({ responseMaxBytes: 8 }),
      evalscopeFetch: vi.fn(async () => Response.json({ status: 'far-too-large' })) as typeof fetch,
    })
    expect((await oversized.fetch(request('/evalscope-api/health'))).status).toBe(502)

    const confused = createTestApp({
      evalscope: config(),
      evalscopeFetch: vi.fn(
        async () =>
          new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }),
      ) as typeof fetch,
    })
    expect((await confused.fetch(request('/evalscope-api/health'))).status).toBe(502)
  })
})

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://databench.test${path}`, init)
}
